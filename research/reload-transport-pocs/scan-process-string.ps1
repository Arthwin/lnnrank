[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [int]$ProcessId,

    [Parameter(Mandatory = $true)]
    [string]$Pattern,

    [ValidateSet("utf8", "utf16", "both")]
    [string]$Encoding = "both",

    [int]$ChunkSizeBytes = 1048576,

    [int]$ContextBytes = 96,

    [int]$MaxMatches = 12
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$typeName = "LnnrankMemoryScan.NativeMethods"
if (-not ($typeName -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

namespace LnnrankMemoryScan {
  public static class NativeMethods {
    [StructLayout(LayoutKind.Sequential)]
    public struct MEMORY_BASIC_INFORMATION {
      public IntPtr BaseAddress;
      public IntPtr AllocationBase;
      public uint AllocationProtect;
      public UIntPtr RegionSize;
      public uint State;
      public uint Protect;
      public uint Type;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct SYSTEM_INFO {
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
    public static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool ReadProcessMemory(
      IntPtr process,
      IntPtr baseAddress,
      [Out] byte[] buffer,
      IntPtr size,
      out IntPtr bytesRead
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr VirtualQueryEx(
      IntPtr process,
      IntPtr address,
      out MEMORY_BASIC_INFORMATION buffer,
      IntPtr length
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll")]
    public static extern void GetSystemInfo(out SYSTEM_INFO info);
  }
}
"@
}

function New-ByteSlice {
    param(
        [byte[]]$Source,
        [int]$Offset,
        [int]$Count
    )

    if (-not $Source -or $Count -le 0) {
        return [byte[]]::new(0)
    }

    $safeOffset = [Math]::Max(0, $Offset)
    $safeCount = [Math]::Min($Count, $Source.Length - $safeOffset)
    if ($safeCount -le 0) {
        return [byte[]]::new(0)
    }

    $result = [byte[]]::new($safeCount)
    [System.Buffer]::BlockCopy($Source, $safeOffset, $result, 0, $safeCount)
    return $result
}

function Join-ByteArrays {
    param(
        [byte[]]$Left,
        [byte[]]$Right
    )

    $leftCount = if ($Left) { $Left.Length } else { 0 }
    $rightCount = if ($Right) { $Right.Length } else { 0 }
    $result = [byte[]]::new($leftCount + $rightCount)

    if ($leftCount -gt 0) {
        [System.Buffer]::BlockCopy($Left, 0, $result, 0, $leftCount)
    }

    if ($rightCount -gt 0) {
        [System.Buffer]::BlockCopy($Right, 0, $result, $leftCount, $rightCount)
    }

    return $result
}

function Find-PatternOffsets {
    param(
        [byte[]]$Bytes,
        [byte[]]$Needle
    )

    $matches = New-Object System.Collections.Generic.List[int]
    if (-not $Bytes -or -not $Needle -or $Needle.Length -eq 0 -or $Bytes.Length -lt $Needle.Length) {
        return $matches
    }

    $lastStart = $Bytes.Length - $Needle.Length
    $index = 0
    while ($index -le $lastStart) {
        $candidate = [System.Array]::IndexOf($Bytes, $Needle[0], $index)
        if ($candidate -lt 0 -or $candidate -gt $lastStart) {
            break
        }

        $isMatch = $true
        for ($needleIndex = 1; $needleIndex -lt $Needle.Length; $needleIndex += 1) {
            if ($Bytes[$candidate + $needleIndex] -ne $Needle[$needleIndex]) {
                $isMatch = $false
                break
            }
        }

        if ($isMatch) {
            [void]$matches.Add($candidate)
        }

        $index = $candidate + 1
    }

    return $matches
}

function Convert-ToPreviewText {
    param(
        [byte[]]$Bytes,
        [System.Text.Encoding]$Decoder
    )

    if (-not $Bytes -or $Bytes.Length -eq 0) {
        return ""
    }

    $text = $Decoder.GetString($Bytes)
    $text = $text -replace "\0", "."
    $text = $text -replace "[^\u0020-\u007E]", "."
    $text = $text -replace "\s+", " "
    return $text.Trim()
}

function New-MatchRecord {
    param(
        [int64]$AbsoluteAddress,
        [string]$EncodingName,
        [int64]$RegionBase,
        [byte[]]$CombinedBuffer,
        [int]$MatchOffset,
        [int]$PatternLength,
        [int]$ContextBytes
    )

    $previewOffset = [Math]::Max(0, $MatchOffset - $ContextBytes)
    $previewCount = [Math]::Min(
        $CombinedBuffer.Length - $previewOffset,
        $PatternLength + ($ContextBytes * 2)
    )
    $previewBytes = New-ByteSlice -Source $CombinedBuffer -Offset $previewOffset -Count $previewCount
    $utf16Count = $previewBytes.Length - ($previewBytes.Length % 2)

    [pscustomobject]@{
        Address = ('0x{0:X}' -f $AbsoluteAddress)
        AddressValue = $AbsoluteAddress
        Encoding = $EncodingName
        RegionBase = ('0x{0:X}' -f $RegionBase)
        PreviewUtf8 = Convert-ToPreviewText -Bytes $previewBytes -Decoder ([System.Text.Encoding]::UTF8)
        PreviewUtf16 = Convert-ToPreviewText -Bytes (New-ByteSlice -Source $previewBytes -Offset 0 -Count $utf16Count) -Decoder ([System.Text.Encoding]::Unicode)
    }
}

$PROCESS_QUERY_INFORMATION = 0x0400
$PROCESS_VM_READ = 0x0010
$MEM_COMMIT = 0x1000
$PAGE_GUARD = 0x100
$PAGE_NOACCESS = 0x01

$patternSets = New-Object System.Collections.Generic.List[object]
if ($Encoding -eq "utf8" -or $Encoding -eq "both") {
    [void]$patternSets.Add([pscustomobject]@{
        Name = "utf8"
        Bytes = [System.Text.Encoding]::UTF8.GetBytes($Pattern)
    })
}

if ($Encoding -eq "utf16" -or $Encoding -eq "both") {
    [void]$patternSets.Add([pscustomobject]@{
        Name = "utf16"
        Bytes = [System.Text.Encoding]::Unicode.GetBytes($Pattern)
    })
}

if ($patternSets.Count -eq 0) {
    throw "No encodings selected."
}

$maxPatternLength = ($patternSets | ForEach-Object { $_.Bytes.Length } | Measure-Object -Maximum).Maximum
$overlapBytes = [Math]::Max($ContextBytes, $maxPatternLength - 1)

$process = Get-Process -Id $ProcessId -ErrorAction Stop
$handle = [LnnrankMemoryScan.NativeMethods]::OpenProcess(
    $PROCESS_QUERY_INFORMATION -bor $PROCESS_VM_READ,
    $false,
    $ProcessId
)

if ($handle -eq [IntPtr]::Zero) {
    throw "OpenProcess failed for PID $ProcessId."
}

try {
    $systemInfo = New-Object LnnrankMemoryScan.NativeMethods+SYSTEM_INFO
    [LnnrankMemoryScan.NativeMethods]::GetSystemInfo([ref]$systemInfo)

    $minimumAddress = $systemInfo.MinimumApplicationAddress.ToInt64()
    $maximumAddress = $systemInfo.MaximumApplicationAddress.ToInt64()
    $mbiSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][LnnrankMemoryScan.NativeMethods+MEMORY_BASIC_INFORMATION])

    $results = New-Object System.Collections.Generic.List[object]
    $seenKeys = New-Object 'System.Collections.Generic.HashSet[string]'
    $address = $minimumAddress

    while ($address -lt $maximumAddress -and $results.Count -lt $MaxMatches) {
        $memoryInfo = New-Object LnnrankMemoryScan.NativeMethods+MEMORY_BASIC_INFORMATION
        $queryResult = [LnnrankMemoryScan.NativeMethods]::VirtualQueryEx(
            $handle,
            [IntPtr]$address,
            [ref]$memoryInfo,
            [IntPtr]$mbiSize
        )

        if ($queryResult -eq [IntPtr]::Zero) {
            break
        }

        $regionBase = $memoryInfo.BaseAddress.ToInt64()
        $regionSize = [int64]$memoryInfo.RegionSize.ToUInt64()
        $nextAddress = $regionBase + $regionSize
        if ($nextAddress -le $address) {
            break
        }

        $isReadable =
            $memoryInfo.State -eq $MEM_COMMIT -and
            ($memoryInfo.Protect -band $PAGE_GUARD) -eq 0 -and
            ($memoryInfo.Protect -band $PAGE_NOACCESS) -eq 0

        if ($isReadable -and $regionSize -gt 0) {
            $tail = [byte[]]::new(0)
            $offset = 0L

            while ($offset -lt $regionSize -and $results.Count -lt $MaxMatches) {
                $remaining = $regionSize - $offset
                $chunkSize = [int][Math]::Min([int64]$ChunkSizeBytes, $remaining)
                if ($chunkSize -le 0) {
                    break
                }

                $chunkBuffer = [byte[]]::new($chunkSize)
                $bytesRead = [IntPtr]::Zero
                $readAddress = [IntPtr]($regionBase + $offset)
                $readOk = [LnnrankMemoryScan.NativeMethods]::ReadProcessMemory(
                    $handle,
                    $readAddress,
                    $chunkBuffer,
                    [IntPtr]$chunkSize,
                    [ref]$bytesRead
                )

                if ($readOk -and $bytesRead.ToInt64() -gt 0) {
                    $actualCount = [int]$bytesRead.ToInt64()
                    $actualBytes = if ($actualCount -eq $chunkBuffer.Length) {
                        $chunkBuffer
                    }
                    else {
                        New-ByteSlice -Source $chunkBuffer -Offset 0 -Count $actualCount
                    }

                    $combined = Join-ByteArrays -Left $tail -Right $actualBytes
                    $combinedBase = ($regionBase + $offset) - $tail.Length

                    foreach ($patternSet in $patternSets) {
                        foreach ($matchOffset in (Find-PatternOffsets -Bytes $combined -Needle $patternSet.Bytes)) {
                            $absoluteAddress = $combinedBase + $matchOffset
                            $matchKey = "$($patternSet.Name):$absoluteAddress"
                            if ($seenKeys.Add($matchKey)) {
                                $record = New-MatchRecord `
                                    -AbsoluteAddress $absoluteAddress `
                                    -EncodingName $patternSet.Name `
                                    -RegionBase $regionBase `
                                    -CombinedBuffer $combined `
                                    -MatchOffset $matchOffset `
                                    -PatternLength $patternSet.Bytes.Length `
                                    -ContextBytes $ContextBytes
                                [void]$results.Add($record)
                                if ($results.Count -ge $MaxMatches) {
                                    break
                                }
                            }
                        }

                        if ($results.Count -ge $MaxMatches) {
                            break
                        }
                    }

                    $tailLength = [Math]::Min($combined.Length, $overlapBytes)
                    $tail = New-ByteSlice -Source $combined -Offset ($combined.Length - $tailLength) -Count $tailLength
                }

                $offset += $chunkSize
            }
        }

        $address = $nextAddress
    }

    if ($results.Count -eq 0) {
        Write-Output "No matches found in PID $ProcessId ($($process.ProcessName))."
        return
    }

    Write-Output "Process: $($process.ProcessName) (PID $ProcessId)"
    Write-Output "Pattern: $Pattern"
    Write-Output "Matches:"
    $results |
        Sort-Object AddressValue, Encoding |
        Select-Object Address, Encoding, RegionBase, PreviewUtf8, PreviewUtf16 |
        Format-Table -Wrap -AutoSize
}
finally {
    [void][LnnrankMemoryScan.NativeMethods]::CloseHandle($handle)
}
