$ErrorActionPreference = 'Stop'
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'

$nativeSource = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../Antigravity-Cat-Widget/src/native/ForegroundHost.cs')).Path
$nativeOutput = [IO.Path]::ChangeExtension($nativeSource, '.exe')
& $csc '/nologo' '/target:exe' '/optimize+' ('/out:' + $nativeOutput) $nativeSource
if ($LASTEXITCODE -ne 0) { throw 'Native helper ForegroundHost.exe compilation failed' }

$connectEntry = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'native/HostConnectEntry.cs')).Path
$hostConnection = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'installer/HostConnection.cs')).Path
$connectOutput = Join-Path $PSScriptRoot 'native/HostConnect.exe'
& $csc '/nologo' '/target:winexe' '/optimize+' '/r:System.Windows.Forms.dll' '/r:System.Drawing.dll' '/r:Microsoft.CSharp.dll' '/r:System.Xml.Linq.dll' ('/out:' + $connectOutput) $connectEntry $hostConnection
if ($LASTEXITCODE -ne 0) { throw 'Native helper HostConnect.exe compilation failed' }
