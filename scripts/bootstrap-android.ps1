# 自动准备 Android 构建环境（JDK17 + Android SDK + Gradle 由 wrapper 自取）
# 用法：powershell -ExecutionPolicy Bypass -File scripts\bootstrap-android.ps1
$ErrorActionPreference = 'Stop'
$root  = Split-Path -Parent $PSScriptRoot
$tools = Join-Path $root '.tools'
$jdk   = Join-Path $tools 'jdk17'
$sdk   = Join-Path $tools 'android-sdk'

function Say($m) { Write-Host "[bootstrap] $m" }
function Get-File($url, $out) {
  Say "下载 $url"
  $ProgressPreference = 'SilentlyContinue'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing
}

New-Item -ItemType Directory -Force -Path $tools | Out-Null

# ---------- 1) JDK 17 ----------
if (-not (Test-Path (Join-Path $jdk 'bin\java.exe'))) {
  $zip = Join-Path $tools 'jdk17.zip'
  if (-not (Test-Path $zip)) {
    # 清华镜像（官方源在国内很慢）
    Get-File 'https://mirrors.tuna.tsinghua.edu.cn/Adoptium/17/jdk/x64/windows/OpenJDK17U-jdk_x64_windows_hotspot_17.0.20.1_1.zip' $zip
  }
  Say '解压 JDK'
  New-Item -ItemType Directory -Force -Path $jdk | Out-Null
  Expand-Archive -Path $zip -DestinationPath $jdk -Force
}
# 压缩包内含一层目录（jdk-17.x），把内容提到 $jdk 根下
if (-not (Test-Path (Join-Path $jdk 'bin\java.exe'))) {
  $inner = Get-ChildItem $jdk -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'bin\java.exe') } | Select-Object -First 1
  if (-not $inner) { $inner = Get-ChildItem $jdk -Directory | Select-Object -First 1 }
  if ($inner) {
    Say ('展平 JDK 目录：' + $inner.Name)
    Get-ChildItem (Join-Path $jdk $inner.Name) -Force | ForEach-Object {
      $dst = Join-Path $jdk $_.Name
      if (Test-Path $dst) { Remove-Item $dst -Recurse -Force -ErrorAction SilentlyContinue }
      Move-Item $_.FullName $dst -Force
    }
    Remove-Item (Join-Path $jdk $inner.Name) -Recurse -Force -ErrorAction SilentlyContinue
  }
} else { Say 'JDK 已存在，跳过' }

$env:JAVA_HOME = $jdk
$env:PATH = (Join-Path $jdk 'bin') + ';' + $env:PATH
& (Join-Path $jdk 'bin\java.exe') -version 2>&1 | Select-Object -First 1

# ---------- 2) Android SDK cmdline-tools ----------
$cmt = Join-Path $sdk 'cmdline-tools\latest\bin\sdkmanager.bat'
if (-not (Test-Path $cmt)) {
  $zip = Join-Path $tools 'cmdline-tools.zip'
  if (-not (Test-Path $zip)) {
    Get-File 'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip' $zip
  }
  Say '解压 Android cmdline-tools'
  $tmp = Join-Path $tools 'cmt'
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $dest = Join-Path $sdk 'cmdline-tools\latest'
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Get-ChildItem (Join-Path $tmp 'cmdline-tools') | ForEach-Object {
    Move-Item $_.FullName (Join-Path $dest $_.Name) -Force
  }
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
} else { Say 'cmdline-tools 已存在，跳过' }

# ---------- 3) 安装 SDK 组件 ----------
$env:ANDROID_SDK_ROOT = $sdk
$env:ANDROID_HOME = $sdk
$env:PATH = (Join-Path $sdk 'cmdline-tools\latest\bin') + ';' + $env:PATH

Say '同意 SDK 许可'
$licDir = Join-Path $sdk 'licenses'
New-Item -ItemType Directory -Force -Path $licDir | Out-Null
Set-Content -Path (Join-Path $licDir 'android-sdk-license') -Value "`n24333f8a63b6825ea9c5514f83c2829b004d1fee" -Encoding ascii
Set-Content -Path (Join-Path $licDir 'android-sdk-preview-license') -Value "`n84831b9409646a918e30573bab4c9c91346d8abd" -Encoding ascii

Say '安装 platform-tools / platforms;android-34 / build-tools;34.0.0'
$sm = Join-Path $sdk 'cmdline-tools\latest\bin\sdkmanager.bat'
& $sm --sdk_root=$sdk 'platform-tools' 'platforms;android-34' 'build-tools;34.0.0' 2>&1 | Select-Object -Last 12

Say '环境就绪'
Write-Host "JAVA_HOME=$jdk"
Write-Host "ANDROID_HOME=$sdk"
