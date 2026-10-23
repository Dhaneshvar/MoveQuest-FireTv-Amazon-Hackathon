package com.motionplay.companion

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognizerIntent
import android.speech.RecognitionListener
import android.speech.SpeechRecognizer
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.*
import com.facebook.react.uimanager.ViewManager

class PhoneVoicePackage : ReactPackage {
  override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> = listOf(PhoneVoiceModule(context))
  override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}

class PhoneVoiceModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context), LifecycleEventListener {
  private val main = Handler(Looper.getMainLooper())
  private var pending: Promise? = null
  private var recognizer: SpeechRecognizer? = null
  private val timeout = Runnable { reject("TIMEOUT", "Voice command timed out. Tap the button and speak one short command.") }
  init { context.addLifecycleEventListener(this) }
  override fun getName() = "PhoneVoice"
  @ReactMethod fun listen(promise: Promise) {
    main.post {
      if (pending != null) { promise.reject("BUSY", "Finish the current voice command first."); return@post }
      if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) { promise.reject("PERMISSION", "Microphone permission is required."); return@post }
      val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_LANGUAGE, "en-US")
        putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
        putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
      }
      try {
        if (!SpeechRecognizer.isRecognitionAvailable(context)) throw IllegalStateException("Enable a speech recognition service on this phone, or use the text command field.")
        val offline = Build.VERSION.SDK_INT >= 31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(context)
        recognizer = if (offline) SpeechRecognizer.createOnDeviceSpeechRecognizer(context) else SpeechRecognizer.createSpeechRecognizer(context)
        recognizer?.setRecognitionListener(object : RecognitionListener {
          override fun onReadyForSpeech(params: Bundle?) {}
          override fun onBeginningOfSpeech() {}
          override fun onRmsChanged(value: Float) {}
          override fun onBufferReceived(bytes: ByteArray?) {}
          override fun onEndOfSpeech() {}
          override fun onPartialResults(results: Bundle?) {}
          override fun onEvent(type: Int, params: Bundle?) {}
          override fun onError(code: Int) { reject("SPEECH_ERROR", "No command recognized (speech service code $code). Try again or use the text command field.") }
          override fun onResults(results: Bundle?) {
            val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
            if (text.isNullOrBlank()) reject("NO_MATCH", "No command heard. Try again.") else {
              val result = pending; pending = null; main.removeCallbacks(timeout)
              result?.resolve(text.take(100)); main.post { releaseRecognizer() }
            }
          }
        })
        pending = promise; recognizer?.startListening(intent); main.postDelayed(timeout, 20000)
      } catch (error: Exception) { pending = null; releaseRecognizer(); promise.reject("UNAVAILABLE", error.message, error) }
    }
  }
  private fun releaseRecognizer() { recognizer?.cancel(); recognizer?.destroy(); recognizer = null }
  private fun reject(code: String, message: String) {
    val result = pending; pending = null; main.removeCallbacks(timeout)
    result?.reject(code, message); main.post { releaseRecognizer() }
  }
  override fun onHostResume() {}
  override fun onHostPause() { main.post { reject("BACKGROUND", "Keep the phone companion open while speaking.") } }
  override fun onHostDestroy() { main.post { reject("CLOSED", "Phone companion closed.") } }
  override fun invalidate() {
    context.removeLifecycleEventListener(this); main.post { reject("CLOSED", "Phone companion closed.") }
    super.invalidate()
  }
}
