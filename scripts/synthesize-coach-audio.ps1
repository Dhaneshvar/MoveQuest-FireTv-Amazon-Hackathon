$ErrorActionPreference = 'Stop'
$voice = New-Object -ComObject SAPI.SpVoice
$voice.Rate = 0
$jobs = Get-Content -LiteralPath '.gradle/coach-audio/jobs.json' -Raw | ConvertFrom-Json
foreach ($job in $jobs) {
  if (Test-Path -LiteralPath $job.file) { continue }
  $audioStream = New-Object -ComObject SAPI.SpFileStream
  $audioStream.Format.Type = 22 # PCM, 22.05 kHz, 16 bit mono
  try {
    $audioStream.Open($job.file, 3, $false)
    $voice.AudioOutputStream = $audioStream
    [void]$voice.Speak($job.text, 0)
  } finally { $audioStream.Close() }
}
Write-Output "Generated $($jobs.Count) bundled voice clips."
