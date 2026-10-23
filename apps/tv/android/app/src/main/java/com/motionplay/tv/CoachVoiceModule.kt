package com.motionplay.tv

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.media.MediaPlayer
import android.media.AudioAttributes
import android.util.Log
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.util.Locale
import org.json.JSONObject

class CoachVoiceModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context), LifecycleEventListener {
  private val main = Handler(Looper.getMainLooper())
  private var tts: TextToSpeech? = null
  private var speechReady = false
  private var recognizer: SpeechRecognizer? = null
  private var listening = false
  private var disposed = false
  private var hostActive = true
  private var player: MediaPlayer? = null
  private val clips = ArrayDeque<String>()
  private val bundled = runCatching { JSONObject(context.assets.open("coach_voice.json").bufferedReader().use { it.readText() }) }.getOrNull()
  private var utteranceCounter = 0L
  private var utteranceId = ""
  private var utteranceText = ""
  private val timeout = Runnable { stopListeningInternal(); event("IDLE", "Listening timed out. Select VOICE COMMAND to try again.") }

  init {
    context.addLifecycleEventListener(this)
    main.post {
      if (!disposed) tts = TextToSpeech(context) { status ->
        main.post {
          if (!disposed && status == TextToSpeech.SUCCESS) {
            val language = tts?.setLanguage(Locale.US)
            speechReady = language != TextToSpeech.LANG_MISSING_DATA && language != TextToSpeech.LANG_NOT_SUPPORTED
            tts?.setSpeechRate(0.92f)
            tts?.setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
              override fun onStart(id: String?) {}
              override fun onDone(id: String?) {}
              override fun onError(id: String?) {
                main.post {
                  if (id == utteranceId && !disposed && !listening && hostActive) {
                    speechReady = false
                    stopPlayback(); clips.addAll(clipSequence(utteranceText)); playNextClip()
                    event("VOICE_READY", "Using bundled coaching audio because the system voice failed.")
                  }
                }
              }
            })
            event("VOICE_READY", if (speechReady) "Spoken coaching ready" else "English voice data is unavailable; follow on-screen coaching.")
          } else event("VOICE_UNAVAILABLE", "No speech output engine is installed; follow on-screen coaching.")
        }
      }
    }
  }

  override fun getName() = "CoachVoice"
  @ReactMethod fun addListener(name: String) {}
  @ReactMethod fun removeListeners(count: Int) {}
  @ReactMethod fun capabilities(promise: Promise) {
    main.post {
      promise.resolve(Arguments.createMap().apply {
        putBoolean("recognition", SpeechRecognizer.isRecognitionAvailable(context))
        putBoolean("speech", speechReady || bundled != null)
        putString("engine", if (bundled != null) "BUNDLED" else if (speechReady) "SYSTEM" else "UNAVAILABLE")
        putBoolean("onDevice", Build.VERSION.SDK_INT >= 31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(context))
      })
    }
  }
  @ReactMethod fun speak(text: String) {
    main.post {
      if (listening || disposed || !hostActive) return@post
      stopPlayback()
      utteranceText = text.trim(); utteranceId = "coach-${++utteranceCounter}"
      val sequence = clipSequence(utteranceText)
      if (bundled != null && sequence.isNotEmpty()) {
        tts?.stop(); clips.addAll(sequence); playNextClip(); return@post
      }
      if (speechReady && tts?.speak(text.take(500), TextToSpeech.QUEUE_FLUSH, null, utteranceId) == TextToSpeech.SUCCESS) {
        Log.i("MoveQuestVoice", "Playing system speech")
      } else {
        tts?.stop()
        clips.addAll(clipSequence(text.trim()))
        if (clips.isEmpty()) event("VOICE_ERROR", "No bundled audio for this instruction. Follow the on-screen cue.") else playNextClip()
      }
    }
  }
  @ReactMethod fun silence() { main.post { utteranceId = ""; tts?.stop(); stopPlayback() } }
  private fun numberWords(number: Int): List<String> {
    val small = listOf("zero","one","two","three","four","five","six","seven","eight","nine","ten","eleven","twelve","thirteen","fourteen","fifteen","sixteen","seventeen","eighteen","nineteen")
    val tens = listOf("", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety")
    if (number !in 0..999) return emptyList()
    if (number < 20) return listOf(small[number])
    if (number < 100) return listOf(tens[number / 10]) + if (number % 10 == 0) emptyList() else listOf(small[number % 10])
    return listOf(small[number / 100], "hundred") + if (number % 100 == 0) emptyList() else numberWords(number % 100)
  }
  private fun clipSequence(text: String): List<String> {
    if (bundled?.has(text) == true) return listOf(text)
    Regex("^Rep (\\d+)\\.$").matchEntire(text)?.let { return listOf("Rep") + numberWords(it.groupValues[1].toInt()) }
    Regex("^Round complete\\. (\\d+) points\\.$").matchEntire(text)?.let { return listOf("Round complete.") + numberWords(it.groupValues[1].toInt()) + "points" }
    Regex("^Session complete\\. (\\d+) repetitions and (\\d+) game points\\.$").matchEntire(text)?.let { return listOf("Session complete.", "Rep") + numberWords(it.groupValues[1].toInt()) + numberWords(it.groupValues[2].toInt()) + "points" }
    return emptyList()
  }
  private fun stopPlayback() {
    clips.clear()
    player?.setOnCompletionListener(null)
    runCatching { player?.stop() }
    player?.release(); player = null
  }
  private fun playNextClip() {
    if (disposed || listening || clips.isEmpty()) return
    val phrase = clips.removeFirst()
    val name = bundled?.optString(phrase).orEmpty()
    val id = context.resources.getIdentifier(name, "raw", context.packageName)
    if (id == 0) { clips.clear(); event("VOICE_ERROR", "Bundled coaching audio is missing. Reinstall the updated TV APK."); return }
    try {
      val next = MediaPlayer.create(context, id) ?: throw IllegalStateException("Audio player could not open the coaching clip")
      player = next
      next.setOnCompletionListener { completed -> if (player === completed) { completed.release(); player = null; playNextClip() } }
      next.setOnErrorListener { failed, _, _ -> if (player === failed) { failed.release(); player = null; clips.clear(); event("VOICE_ERROR", "TV audio playback failed. Check the media volume and audio output.") }; true }
      next.start()
      Log.i("MoveQuestVoice", "Playing bundled coaching audio: $name")
    } catch (error: Exception) { stopPlayback(); event("VOICE_ERROR", "Could not play coaching audio: ${error.message}") }
  }
  @ReactMethod fun listen(promise: Promise) {
    main.post {
      if (disposed || listening) { promise.reject("BUSY", "A voice command is already in progress."); return@post }
      if (!SpeechRecognizer.isRecognitionAvailable(context)) {
        promise.reject("UNAVAILABLE", "This TV does not expose an app speech service. Use the remote controls; Alexa's microphone is managed by Fire TV.")
        return@post
      }
      if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
        promise.reject("PERMISSION", "Microphone permission is needed for voice commands."); return@post
      }
      try {
        tts?.stop()
        stopPlayback()
        recognizer?.destroy()
        val offline = Build.VERSION.SDK_INT >= 31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(context)
        recognizer = if (offline) SpeechRecognizer.createOnDeviceSpeechRecognizer(context) else SpeechRecognizer.createSpeechRecognizer(context)
        recognizer?.setRecognitionListener(object : RecognitionListener {
          override fun onReadyForSpeech(params: Bundle?) { event("LISTENING", "Say one command, such as pause, resume, squats, or home.") }
          override fun onBeginningOfSpeech() {}
          override fun onRmsChanged(rmsdB: Float) {}
          override fun onBufferReceived(buffer: ByteArray?) {}
          override fun onEndOfSpeech() { event("PROCESSING", "Recognizing command…") }
          override fun onError(error: Int) {
            listening = false; main.removeCallbacks(timeout)
            val message = when (error) {
              SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Microphone permission was denied. Use the remote controls."
              SpeechRecognizer.ERROR_AUDIO -> "This TV microphone is not available to apps. Use the remote controls."
              SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "No command heard. Select VOICE COMMAND and try again."
              else -> "Speech service error ($error). Try again or use the remote."
            }
            event("ERROR", message)
          }
          override fun onResults(results: Bundle?) {
            listening = false; main.removeCallbacks(timeout)
            event("RESULT", results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty())
          }
          override fun onPartialResults(partialResults: Bundle?) {}
          override fun onEvent(eventType: Int, params: Bundle?) {}
        })
        listening = true
        recognizer?.startListening(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
          putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
          putExtra(RecognizerIntent.EXTRA_LANGUAGE, "en-US")
          putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
          putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
        })
        main.postDelayed(timeout, 12000)
        promise.resolve(true)
      } catch (error: Exception) {
        stopListeningInternal()
        promise.reject("SPEECH_ERROR", "Could not start the TV speech service. Use the remote controls.", error)
      }
    }
  }
  @ReactMethod fun stopListening() { main.post { stopListeningInternal() } }
  private fun stopListeningInternal() {
    listening = false; main.removeCallbacks(timeout)
    recognizer?.cancel(); recognizer?.destroy(); recognizer = null
  }
  private fun event(state: String, message: String) {
    if (!disposed) context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit("CoachVoiceEvent", Arguments.createMap().apply { putString("state", state); putString("message", message) })
  }
  override fun onHostPause() { main.post { hostActive = false; utteranceId = ""; stopListeningInternal(); tts?.stop(); stopPlayback() } }
  override fun onHostResume() { main.post { hostActive = true } }
  override fun onHostDestroy() { main.post { stopListeningInternal(); tts?.stop(); stopPlayback() } }
  override fun invalidate() {
    disposed = true; context.removeLifecycleEventListener(this)
    main.post { stopListeningInternal(); stopPlayback(); tts?.shutdown(); tts = null }
    super.invalidate()
  }
}
