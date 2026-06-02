using System.ComponentModel;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Globalization;
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

if (string.Equals(args[0], "scan-regions", StringComparison.OrdinalIgnoreCase))
{
    var options = ScanRegionsOptions.Parse(args.Skip(1).ToArray());
    var stopwatch = Stopwatch.StartNew();
    var matches = PassiveScanner.ScanRegions(options);
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

internal sealed record ScanRegionsOptions(
    int ProcessId,
    IReadOnlyList<RegionSpec> Regions,
    string Pattern,
    int MaxMatches,
    int ContextBytes,
    int ChunkSizeBytes)
{
    public static ScanRegionsOptions Parse(string[] args)
    {
        int? processId = null;
        var regions = new List<RegionSpec>();
        string pattern = "LNNRANK|";
        int maxMatches = 24;
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
                case "--regions":
                    foreach (var value in NextValue().Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
                    {
                        var parts = value.Split(':', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
                        if (parts.Length != 2)
                        {
                            throw new ArgumentException($"Invalid region spec '{value}'. Expected base:size.");
                        }

                        var baseAddress = ParseLongValue(parts[0]);
                        var regionSize = ParseLongValue(parts[1]);
                        if (baseAddress <= 0 || regionSize <= 0)
                        {
                            continue;
                        }

                        regions.Add(new RegionSpec(baseAddress, regionSize));
                    }
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

        if (regions.Count == 0)
        {
            throw new ArgumentException("--regions is required.");
        }

        if (string.IsNullOrWhiteSpace(pattern))
        {
            throw new ArgumentException("--pattern is required.");
        }

        return new ScanRegionsOptions(processId.Value, regions, pattern, maxMatches, contextBytes, chunkSizeBytes);
    }

    private static long ParseLongValue(string value)
    {
        var normalized = string.IsNullOrWhiteSpace(value) ? "" : value.Trim();
        if (normalized.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
        {
            return Convert.ToInt64(normalized[2..], 16);
        }

        return long.Parse(normalized, CultureInfo.InvariantCulture);
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

internal sealed record RegionSpec(long BaseAddress, long RegionSize);

internal static class PassiveScanner
{
    private const uint ProcessQueryInformation = 0x0400;
    private const uint ProcessVmRead = 0x0010;
    private const uint MemCommit = 0x1000;
    private const uint MemPrivate = 0x20000;
    private const uint PageGuard = 0x100;
    private const uint PageNoAccess = 0x01;
    private const long DiscoverRegionScanBytes = 2 * 1024 * 1024;
    private const int DiscoverMaxParallelism = 4;

    public static IReadOnlyList<MatchResult> Discover(DiscoverOptions options)
    {
        var patternSets = CreatePatternSets(options.Pattern);
        var overlapBytes = GetOverlapBytes(options.ContextBytes, patternSets);
        NativeMethods.GetSystemInfo(out var systemInfo);
        using var processHandle = OpenProcess(options.ProcessId);
        var memoryInfoSize = Marshal.SizeOf<NativeMethods.MemoryBasicInformation>();
        var currentAddress = systemInfo.MinimumApplicationAddress.ToInt64();
        var maxAddress = systemInfo.MaximumApplicationAddress.ToInt64();
        var regions = new List<(long RegionBase, long RegionSize)>();

        while (currentAddress < maxAddress)
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
                memoryInfo.Type == MemPrivate &&
                (memoryInfo.Protect & PageGuard) == 0 &&
                (memoryInfo.Protect & PageNoAccess) == 0;

            if (isReadable && regionSize > 0)
            {
                regions.Add((regionBase, regionSize));
            }

            currentAddress = nextAddress;
        }

        var discoveredMatches = new ConcurrentBag<MatchResult>();
        var parallelOptions = new ParallelOptions
        {
            MaxDegreeOfParallelism = Math.Max(1, Math.Min(Environment.ProcessorCount, DiscoverMaxParallelism))
        };

        Parallel.ForEach(regions, parallelOptions, region =>
        {
            var localResults = new List<MatchResult>();
            var localSeenKeys = new HashSet<string>(StringComparer.Ordinal);
            ScanRegion(
                processHandle,
                region.RegionBase,
                Math.Min(region.RegionSize, DiscoverRegionScanBytes),
                int.MaxValue,
                options.ContextBytes,
                options.ChunkSizeBytes,
                overlapBytes,
                patternSets,
                localResults,
                localSeenKeys);
            foreach (var match in localResults)
            {
                discoveredMatches.Add(match);
            }
        });

        return SelectNewestMatches(discoveredMatches.ToArray(), options.MaxMatches);
    }

    public static IReadOnlyList<MatchResult> ScanRegions(ScanRegionsOptions options)
    {
        var patternSets = CreatePatternSets(options.Pattern);
        var overlapBytes = GetOverlapBytes(options.ContextBytes, patternSets);
        var results = new List<MatchResult>();
        var seenKeys = new HashSet<string>(StringComparer.Ordinal);

        using var processHandle = OpenProcess(options.ProcessId);
        foreach (var region in options.Regions)
        {
            if (results.Count >= options.MaxMatches)
            {
                break;
            }

            ScanRegion(
                processHandle,
                region.BaseAddress,
                region.RegionSize,
                options.MaxMatches,
                options.ContextBytes,
                options.ChunkSizeBytes,
                overlapBytes,
                patternSets,
                results,
                seenKeys);
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
            results.Add(BuildMatch(
                "window",
                address,
                baseAddress,
                actualBytes.LongLength,
                actualBytes,
                options.ContextBytes,
                0,
                options.ContextBytes));
        }

        return results;
    }

    private static void ScanRegion(
        SafeProcessHandle processHandle,
        long regionBase,
        long regionSize,
        int maxMatches,
        int contextBytes,
        int chunkSizeBytes,
        int overlapBytes,
        IReadOnlyList<PatternSet> patternSets,
        List<MatchResult> results,
        HashSet<string> seenKeys)
    {
        var tail = Array.Empty<byte>();
        long offset = 0;

        while (offset < regionSize && results.Count < maxMatches)
        {
            var remaining = regionSize - offset;
            var chunkSize = (int)Math.Min(chunkSizeBytes, remaining);
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

                    results.Add(BuildMatch(
                        patternSet.Name,
                        absoluteAddress,
                        regionBase,
                        regionSize,
                        combined,
                        matchOffset,
                        patternSet.Bytes.Length,
                        contextBytes));
                    if (results.Count >= maxMatches)
                    {
                        break;
                    }
                }

                if (results.Count >= maxMatches)
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
        long regionSize,
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
            RegionSize: regionSize.ToString(CultureInfo.InvariantCulture),
            PreviewUtf8: SanitizePreview(Encoding.UTF8.GetString(previewBytes)),
            PreviewUtf16: SanitizePreview(Encoding.Unicode.GetString(utf16Bytes)));
    }

    private static IReadOnlyList<PatternSet> CreatePatternSets(string pattern) => new[]
    {
        new PatternSet("utf8", Encoding.UTF8.GetBytes(pattern)),
        new PatternSet("utf16", Encoding.Unicode.GetBytes(pattern)),
    };

    private static int GetOverlapBytes(int contextBytes, IReadOnlyList<PatternSet> patternSets) =>
        Math.Max(contextBytes, patternSets.Max(set => set.Bytes.Length) - 1);

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

    private static IReadOnlyList<MatchResult> SelectNewestMatches(IReadOnlyList<MatchResult> matches, int maxMatches)
    {
        if (matches.Count <= Math.Max(1, maxMatches))
        {
            return matches;
        }

        return matches
            .OrderByDescending(ExtractPayloadTimestampMs)
            .ThenByDescending(ExtractPayloadSequence)
            .ThenByDescending(match => ParseAddress(match.Address))
            .Take(Math.Max(1, maxMatches))
            .ToArray();
    }

    private static long ExtractPayloadTimestampMs(MatchResult match) => Math.Max(
        ExtractLongField(match.PreviewUtf8, "|t="),
        ExtractLongField(match.PreviewUtf16, "|t="));

    private static long ExtractPayloadSequence(MatchResult match) => Math.Max(
        ExtractLongField(match.PreviewUtf8, "|n="),
        ExtractLongField(match.PreviewUtf16, "|n="));

    private static long ExtractLongField(string value, string key)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return 0;
        }

        var normalized = value.Replace("||", "|", StringComparison.Ordinal).Replace('^', '|');
        var index = normalized.IndexOf(key, StringComparison.Ordinal);
        if (index < 0)
        {
            return 0;
        }

        index += key.Length;
        var end = index;
        while (end < normalized.Length && char.IsDigit(normalized[end]))
        {
            end += 1;
        }

        return end > index && long.TryParse(normalized[index..end], NumberStyles.None, CultureInfo.InvariantCulture, out var parsed)
            ? parsed
            : 0;
    }

    private static long ParseAddress(string value)
    {
        var normalized = string.IsNullOrWhiteSpace(value) ? "" : value.Trim();
        if (normalized.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
        {
            return long.TryParse(normalized[2..], NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var parsed)
                ? parsed
                : 0;
        }

        return long.TryParse(normalized, NumberStyles.Integer, CultureInfo.InvariantCulture, out var decimalValue)
            ? decimalValue
            : 0;
    }

    private static IReadOnlyList<int> FindPatternOffsets(byte[] bytes, byte[] needle)
    {
        var offsets = new List<int>();
        if (needle.Length == 0 || bytes.Length < needle.Length)
        {
            return offsets;
        }

        var searchOffset = 0;
        while (searchOffset <= bytes.Length - needle.Length)
        {
            var relativeOffset = bytes.AsSpan(searchOffset).IndexOf(needle);
            if (relativeOffset < 0)
            {
                break;
            }

            var absoluteOffset = searchOffset + relativeOffset;
            offsets.Add(absoluteOffset);
            searchOffset = absoluteOffset + 1;
        }

        return offsets;
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
    string RegionSize,
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
