$env:LIBCLANG_PATH = 'C:\Users\Administrator\.local\libclang'
$env:PATH = (($env:PATH -split ';') | Where-Object { $_ -notlike '*LLVM-MinGW*' -and $_ -notlike '*WinLibs*' }) -join ';'
$env:PATH = 'C:\Users\Administrator\.local\cmake-3.31.8\bin;' + $env:PATH
Write-Output 'ENV-READY'
cargo build
