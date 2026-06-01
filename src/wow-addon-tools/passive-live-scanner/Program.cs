using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

if (args.Length == 0)
{
    Console.Error.WriteLine("Usage: PassiveLiveScanner <discover|read> ...");
    Environment.ExitCode = 1;
    return;
}

if (string.Equals(args[0], "discover", StringComparison.OrdinalIgnoreCase))
{
    var options = DiscoverOptions.Parse(args.Skip(1).ToArray());
    var stopwatch = Stopwatch.StartNew();
    var matches = PassiveScanner.Discover(options);
    stopwatch.Stop();

    var payload = new
    {
        processId = options.ProcessId,
        pattern = options.Pattern,
        durationMs = stopwatch.ElapsedMilliseconds,
        matches
    };

    Console.WriteLine(JsonSerializer.Serialize(payload));
    return;
}

if (string.Equals(args[0], "read", StringComparison.OrdinalIgnoreCase))
{
    var options = ReadOptions.Parse(args.Skip(1).ToArray());
    var stopwatch = Stopwatch.StartNew();
    var matches = PassiveScanner.ReadAddresses(options);
    stopwatch.Stop();

    var payload = new
    {
        processId = options.ProcessId,
        durationMs = stopwatch.ElapsedMilliseconds,
        matches
    };

    Console.WriteLine(JsonSerializer.Serialize(payload));
    return;
}

Console.Error.WriteLine("Usage: PassiveLiveScanner <discover|read> ...");
Environment.ExitCode = 1;

internal sealed record DiscoverOptions(
    int ProcessId,
    string Pattern,
    int MaxMatches,
    int ContextBytes,
    int ChunkSizeBytes)
{
    public static DiscoverOptions Parse(string[] args)
    {
        int? processId = null;
        string? pattern = null;
        int maxMatches = 8;
        int contextBytes = 192;
        int chunkSizeBytes = 1024 * 1024;

        for (var index = 0; index < args.Length; index += 1)
        {
            var arg = args[index];
            string NextValue()
            {
                if (index + 1 >= args.Length)
                {
                    throw new ArgumentException($"Missing value after {arg}.");
                }

                index += 1;
                return args[index];
            }

            switch (arg)
            {
                case "--pid":
                    processId = int.Parse(NextValue());
                    break;
                case "--pattern":
                    pattern = NextValue();
                    break;
                case "--maxMatches":
                    maxMatches = int.Parse(NextValue());
                    break;
                case "--contextBytes":
                    contextBytes = int.Parse(NextValue());
                    break;
                case "--chunkSizeBytes":
                    chunkSizeBytes = int.Parse(NextValue());
                    break;
            }
        }

        if (processId is null || processId <= 0)
        {
            throw new ArgumentException("--pid is required.");
        }

        if (string.IsNullOrWhiteSpace(pattern))
        {
            throw new ArgumentException("--pattern is required.");
        }

        return new DiscoverOptions(processId.Value, pattern, maxMatches, contextBytes, chunkSizeBytes);
    }
}

internal sealed record ReadOptions(
    int ProcessId,
    IReadOnlyList<long> Addresses,
    int ContextBytes)
{
    public static ReadOptions Parse(string[] args)
    {
        int? processId = null;
        var addresses = new List<long>();
        int contextBytes = 256;

        for (var index = 0; index < args.Length; index += 1)
        {
            var arg = args[index];
            string NextValue()
            {
                if (index + 1 >= args.Length)
                {
                    throw new ArgumentException($"Missing value after {arg}.");
                }

                index += 1;
                return args[index];
            }

            switch (arg)
            {
                case "--pid":
                    processId = int.Parse(NextValue());
                    break;
                case "--addresses":
                    foreach (var value in NextValue().Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
                    {
                        var normalized = value.StartsWith("0x", StringComparison.OrdinalIgnoreCase) ? value[2..] : value;
                        addresses.Add(Convert.ToInt64(normalized, 16));
                    }
                    break;
                case "--contextBytes":
                    contextBytes = int.Parse(NextValue());
                    break;
            }
        }

        if (processId is null || processId <= 0)
        {
            throw new ArgumentException("--pid is required.");
        }

        if (addresses.Count == 0)
        {
            throw new ArgumentException("--addresses is required.");
        }

        return new ReadOptions(processId.Value, addresses, contextBytes);
    }
}

internal static class PassiveScanner
{
    private const uint ProcessQueryInformation = 0x0400;
    private const uint ProcessVmRead = 0x0010;
    private const uint MemCommit = 0x1000;
    private const uint PageGuard = 0x100;
    private const uint PageNoAccess = 0x01;

    public static IReadOnlyList<MatchResult> Discover(DiscoverOptions options)
    {
        var patternSets = new[]
        {
            new PatternSet("utf8", Encoding.UTF8.GetBytes(options.Pattern)),
            new PatternSet("utf16", Encoding.Unicode.GetBytes(options.Pattern)),
        };
        var overlapBytes = Math.Max(options.ContextBytes, patternSets.Max(set => set.Bytes.Length) - 1);
        var results = new List<MatchResult>();
        var seenKeys = new HashSet<string>(StringComparer.Ordinal);

        NativeMethods.GetSystemInfo(out var systemInfo);
        var currentAddress = systemInfo.MinimumApplicationAddress.ToInt64();
        var maxAddress = systemInfo.MaximumApplicationAddress.ToInt64();

        using var processHandle = OpenProcess(options.ProcessId);
        var memoryInfoSize = Marshal.SizeOf<NativeMethods.MemoryBasicInformation>();

        while (currentAddress < maxAddress && results.Count < options.MaxMatches)
        {
            if (NativeMethods.VirtualQueryEx(processHandle, new IntPtr(currentAddress), out var memoryInfo, new IntPtr(memoryInfoSize)) == IntPtr.Zero)
            {
                break;
            }

            var regionBase = memoryInfo.BaseAddress.ToInt64();
            var regionSize = checked((long)memoryInfo.RegionSize.ToUInt64());
            var nextAddress = regionBase + regionSize;
            if (nextAddress <= currentAddress)
            {
                break;
            }

            var isReadable =
                memoryInfo.State == MemCommit &&
                (memoryInfo.Protect & PageGuard) == 0 &&
                (memoryInfo.Protect & PageNoAccess) == 0;

            if (isReadable && regionSize > 0)
            {
                ScanRegion(
                    processHandle,
                    regionBase,
                    regionSize,
                    options,
                    overlapBytes,
                    patternSets,
                    results,
                    seenKeys);
            }

            currentAddress = nextAddress;
        }

        return results;
    }

    public static IReadOnlyList<MatchResult> ReadAddresses(ReadOptions options)
    {
        var results = new List<MatchResult>();
        using var processHandle = OpenProcess(options.ProcessId);

        foreach (var address in options.Addresses)
        {
            var previewLength = Math.Max(128, options.ContextBytes * 2);
            var baseAddress = Math.Max(0, address - options.ContextBytes);
            var buffer = new byte[previewLength];

            if (!NativeMethods.ReadProcessMemory(processHandle, new IntPtr(baseAddress), buffer, new IntPtr(previewLength), out var bytesReadPtr))
            {
                continue;
            }

            var bytesRead = bytesReadPtr.ToInt64();
            if (bytesRead <= 0)
            {
                continue;
            }

            var actualBytes = bytesRead == buffer.Length ? buffer : buffer.AsSpan(0, (int)bytesRead).ToArray();
            results.Add(BuildMatch("window", address, baseAddress, actualBytes, options.ContextBytes, 0, options.ContextBytes));
        }

        return results;
    }

    private static void ScanRegion(
        SafeProcessHandle processHandle,
        long regionBase,
        long regionSize,
        DiscoverOptions options,
        int overlapBytes,
        IReadOnlyList<PatternSet> patternSets,
        List<MatchResult> results,
        HashSet<string> seenKeys)
    {
        var tail = Array.Empty<byte>();
        long offset = 0;

        while (offset < regionSize && results.Count < options.MaxMatches)
        {
            var remaining = regionSize - offset;
            var chunkSize = (int)Math.Min(options.ChunkSizeBytes, remaining);
            if (chunkSize <= 0)
            {
                break;
            }

            var buffer = new byte[chunkSize];
            if (!NativeMethods.ReadProcessMemory(processHandle, new IntPtr(regionBase + offset), buffer, new IntPtr(chunkSize), out var bytesReadPtr))
            {
                offset += chunkSize;
                continue;
            }

            var bytesRead = bytesReadPtr.ToInt64();
            if (bytesRead <= 0)
            {
                offset += chunkSize;
                continue;
            }

            var actualBytes = bytesRead == buffer.Length ? buffer : buffer.AsSpan(0, (int)bytesRead).ToArray();
            var combined = CombineArrays(tail, actualBytes);
            var combinedBase = regionBase + offset - tail.Length;

            foreach (var patternSet in patternSets)
            {
                foreach (var matchOffset in FindPatternOffsets(combined, patternSet.Bytes))
                {
                    var absoluteAddress = combinedBase + matchOffset;
                    var dedupeKey = $"{patternSet.Name}:{absoluteAddress}";
                    if (!seenKeys.Add(dedupeKey))
                    {
                        continue;
                    }

                    results.Add(BuildMatch(patternSet.Name, absoluteAddress, regionBase, combined, matchOffset, patternSet.Bytes.Length, options.ContextBytes));
                    if (results.Count >= options.MaxMatches)
                    {
                        break;
                    }
                }

                if (results.Count >= options.MaxMatches)
                {
                    break;
                }
            }

            var tailLength = Math.Min(combined.Length, overlapBytes);
            tail = tailLength > 0 ? combined.AsSpan(combined.Length - tailLength, tailLength).ToArray() : Array.Empty<byte>();
            offset += chunkSize;
        }
    }

    private static MatchResult BuildMatch(
        string encoding,
        long absoluteAddress,
        long regionBase,
        byte[] combinedBuffer,
        int matchOffset,
        int patternLength,
        int contextBytes)
    {
        var previewOffset = Math.Max(0, matchOffset - contextBytes);
        var previewCount = Math.Min(combinedBuffer.Length - previewOffset, patternLength + (contextBytes * 2));
        var previewBytes = combinedBuffer.AsSpan(previewOffset, previewCount).ToArray();
        var utf16Length = previewBytes.Length - (previewBytes.Length % 2);
        var utf16Bytes = utf16Length > 0 ? previewBytes.AsSpan(0, utf16Length).ToArray() : Array.Empty<byte>();

        return new MatchResult(
            Address: $"0x{absoluteAddress:X}",
            Encoding: encoding,
            RegionBase: $"0x{regionBase:X}",
            PreviewUtf8: SanitizePreview(Encoding.UTF8.GetString(previewBytes)),
            PreviewUtf16: SanitizePreview(Encoding.Unicode.GetString(utf16Bytes)));
    }

    private static string SanitizePreview(string value)
    {
        var builder = new StringBuilder(value.Length);
        foreach (var character in value)
        {
            if (character == '\0')
            {
                builder.Append('.');
                continue;
            }

            if (character is >= ' ' and <= '~')
            {
                builder.Append(character);
                continue;
            }

            builder.Append('.');
        }

        return builder
            .ToString()
            .Replace('\r', ' ')
            .Replace('\n', ' ')
            .Trim();
    }

    private static IEnumerable<int> FindPatternOffsets(byte[] bytes, byte[] needle)
    {
        if (needle.Length == 0 || bytes.Length < needle.Length)
        {
            yield break;
        }

        for (var index = 0; index <= bytes.Length - needle.Length; index += 1)
        {
            if (bytes[index] != needle[0])
            {
                continue;
            }

            var matches = true;
            for (var needleIndex = 1; needleIndex < needle.Length; needleIndex += 1)
            {
                if (bytes[index + needleIndex] != needle[needleIndex])
                {
                    matches = false;
                    break;
                }
            }

            if (matches)
            {
                yield return index;
            }
        }
    }

    private static byte[] CombineArrays(byte[] left, byte[] right)
    {
        var combined = new byte[left.Length + right.Length];
        Buffer.BlockCopy(left, 0, combined, 0, left.Length);
        Buffer.BlockCopy(right, 0, combined, left.Length, right.Length);
        return combined;
    }

    private static SafeProcessHandle OpenProcess(int processId)
    {
        var handle = NativeMethods.OpenProcess(ProcessQueryInformation | ProcessVmRead, false, processId);
        if (handle.IsInvalid)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), $"OpenProcess failed for PID {processId}.");
        }

        return handle;
    }
}

internal sealed record PatternSet(string Name, byte[] Bytes);

internal sealed record MatchResult(
    string Address,
    string Encoding,
    string RegionBase,
    string PreviewUtf8,
    string PreviewUtf16);

internal static class NativeMethods
{
    [StructLayout(LayoutKind.Sequential)]
    public struct MemoryBasicInformation
    {
        public IntPtr BaseAddress;
        public IntPtr AllocationBase;
        public uint AllocationProtect;
        public UIntPtr RegionSize;
        public uint State;
        public uint Protect;
        public uint Type;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct SystemInfo
    {
        public ushort ProcessorArchitecture;
        public ushort Reserved;
        public uint PageSize;
        public IntPtr MinimumApplicationAddress;
        public IntPtr MaximumApplicationAddress;
        public IntPtr ActiveProcessorMask;
        public uint NumberOfProcessors;
        public uint ProcessorType;
        public uint AllocationGranularity;
        public ushort ProcessorLevel;
        public ushort ProcessorRevision;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern SafeProcessHandle OpenProcess(uint desiredAccess, bool inheritHandle, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool ReadProcessMemory(
        SafeProcessHandle process,
        IntPtr baseAddress,
        [Out] byte[] buffer,
        IntPtr size,
        out IntPtr bytesRead);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr VirtualQueryEx(
        SafeProcessHandle process,
        IntPtr address,
        out MemoryBasicInformation buffer,
        IntPtr length);

    [DllImport("kernel32.dll")]
    public static extern void GetSystemInfo(out SystemInfo info);
}

internal sealed class SafeProcessHandle : SafeHandle
{
    public SafeProcessHandle()
        : base(IntPtr.Zero, true)
    {
    }

    public override bool IsInvalid => handle == IntPtr.Zero || handle == new IntPtr(-1);

    protected override bool ReleaseHandle() => CloseHandle(handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);
}
