package com.motionplay.tv

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.SystemClock
import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.google.mediapipe.framework.image.BitmapImageBuilder
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.vision.core.RunningMode
import com.google.mediapipe.tasks.vision.gesturerecognizer.GestureRecognizer
import com.google.mediapipe.tasks.vision.poselandmarker.PoseLandmarker
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.atomic.AtomicBoolean

class MotionCameraModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private val executor = Executors.newSingleThreadExecutor()
  private val active = AtomicBoolean(false)
  @Volatile private var streamTask: Future<*>? = null
  @Volatile private var activeConnection: HttpURLConnection? = null
  @Volatile private var poseTask: PoseLandmarker? = null
  @Volatile private var gestureTask: GestureRecognizer? = null
  @Volatile private var lastPreviewAt = 0L

  override fun getName() = "MotionCamera"

  @ReactMethod
  fun addListener(eventName: String) { }

  @ReactMethod
  fun removeListeners(count: Int) { }

  @ReactMethod
  fun startStream(streamUrl: String, promise: Promise) {
    stopStreamInternal()
    val parsed = runCatching { URL(streamUrl) }.getOrElse {
      promise.reject("INVALID_URL", "Enter a full MJPEG URL, such as http://192.168.1.20:8080/video", it)
      return
    }
    if (parsed.protocol != "http") {
      promise.reject("UNSUPPORTED_URL", "Use a local HTTP MJPEG stream (http://…/video).", null)
      return
    }
    active.set(true)
    emitStatus("CONNECTING", "Connecting to phone camera…")
    streamTask = executor.submit {
      var connection: HttpURLConnection? = null
      try {
        initializeTasks()
        connection = (parsed.openConnection() as HttpURLConnection).apply {
          connectTimeout = 6000
          readTimeout = 0
          setRequestProperty("Accept", "multipart/x-mixed-replace")
          setRequestProperty("User-Agent", "MotionPlay-TV/1.0")
          connect()
        }
        activeConnection = connection
        if (connection.responseCode !in 200..299) throw IllegalStateException("Camera returned HTTP ${connection.responseCode}")
        val contentType = connection.contentType ?: ""
        if (!contentType.contains("multipart", ignoreCase = true)) {
          throw IllegalStateException("URL is reachable, but it is not a multipart MJPEG stream (Content-Type: $contentType)")
        }
        val boundaryHeader = contentType.substringAfter("boundary=", "").trim().trim('"')
        if (boundaryHeader.isBlank()) throw IllegalStateException("MJPEG response did not specify a boundary")
        val boundary = if (boundaryHeader.startsWith("--")) boundaryHeader else "--$boundaryHeader"
        emitStatus("CONNECTED", "Camera connected · detection runs on this TV")
        readMjpeg(BufferedInputStream(connection.inputStream), boundary)
        if (active.get()) throw IllegalStateException("Camera stream ended")
      } catch (error: Throwable) {
        if (active.get()) emitStatus("ERROR", error.message ?: "Could not read the camera stream")
      } finally {
        active.set(false)
        connection?.disconnect()
        activeConnection = null
        closeTasks()
      }
    }
    promise.resolve(true)
  }

  @ReactMethod
  fun stopStream(promise: Promise) {
    stopStreamInternal()
    emitStatus("STOPPED", "Camera disconnected")
    promise.resolve(true)
  }

  private fun stopStreamInternal() {
    active.set(false)
    activeConnection?.disconnect()
    activeConnection = null
    streamTask?.cancel(true)
    streamTask = null
    closeTasks()
  }

  private fun initializeTasks() {
    val poseOptions = PoseLandmarker.PoseLandmarkerOptions.builder()
      .setBaseOptions(BaseOptions.builder().setModelAssetPath("pose_landmarker_full.task").build())
      .setRunningMode(RunningMode.VIDEO)
      .setNumPoses(4)
      .setMinPoseDetectionConfidence(0.5f)
      .setMinPosePresenceConfidence(0.5f)
      .setMinTrackingConfidence(0.5f)
      .build()
    val gestureOptions = GestureRecognizer.GestureRecognizerOptions.builder()
      .setBaseOptions(BaseOptions.builder().setModelAssetPath("gesture_recognizer.task").build())
      .setRunningMode(RunningMode.VIDEO)
      .setNumHands(2)
      .setMinHandDetectionConfidence(0.55f)
      .setMinHandPresenceConfidence(0.55f)
      .setMinTrackingConfidence(0.55f)
      .build()
    poseTask = PoseLandmarker.createFromOptions(reactApplicationContext, poseOptions)
    gestureTask = GestureRecognizer.createFromOptions(reactApplicationContext, gestureOptions)
  }

  private fun readMjpeg(input: BufferedInputStream, boundary: String) {
    var lastInferenceAt = 0L
    var partLine = readLine(input)
    while (active.get() && partLine != null) {
      if (!partLine.startsWith(boundary)) {
        partLine = readLine(input)
        continue
      }
      var length = -1
      while (true) {
        val header = readLine(input) ?: return
        if (header.isEmpty()) break
        if (header.startsWith("Content-Length:", ignoreCase = true)) length = header.substringAfter(':').trim().toIntOrNull() ?: -1
      }
      if (length <= 0 || length > 4_000_000) throw IllegalStateException("Invalid MJPEG frame length ($length); use an IP Webcam JPEG/MJPEG stream")
      val jpeg = readExactly(input, length) ?: return
      readLine(input) // CRLF after JPEG bytes.
      val now = SystemClock.elapsedRealtime()
      if (now - lastInferenceAt >= 300L) {
        lastInferenceAt = now
        processJpeg(jpeg, now)
      }
      partLine = readLine(input)
    }
  }

  private fun processJpeg(bytes: ByteArray, timestamp: Long) {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    var sample = 1
    while (bounds.outWidth / sample > 640 || bounds.outHeight / sample > 480) sample *= 2
    val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample; inPreferredConfig = Bitmap.Config.ARGB_8888 }) ?: return
    try {
      val image = BitmapImageBuilder(bitmap).build()
      val poses = poseTask?.detectForVideo(image, timestamp)
      val hands = gestureTask?.recognizeForVideo(image, timestamp)
      val event = Arguments.createMap()
      val poseArray = Arguments.createArray()
      poses?.landmarks()?.forEach { pose ->
        val pointArray = Arguments.createArray()
        pose.forEach { point ->
          val item = Arguments.createMap()
          item.putDouble("x", point.x().toDouble())
          item.putDouble("y", point.y().toDouble())
          item.putDouble("visibility", point.visibility().orElse(1.0f).toDouble())
          pointArray.pushMap(item)
        }
        poseArray.pushArray(pointArray)
      }
      event.putArray("poses", poseArray)
      val gestureArray = Arguments.createArray()
      hands?.gestures()?.forEachIndexed { index, categories ->
        val category = categories.firstOrNull() ?: return@forEachIndexed
        val landmarks = hands.landmarks().getOrNull(index).orEmpty()
        val centerX = landmarks.map { it.x().toDouble() }.average().takeIf { it.isFinite() } ?: 0.5
        val centerY = landmarks.map { it.y().toDouble() }.average().takeIf { it.isFinite() } ?: 0.5
        val item = Arguments.createMap()
        item.putString("gesture", category.categoryName())
        item.putDouble("score", category.score().toDouble())
        item.putDouble("x", centerX)
        item.putDouble("y", centerY)
        gestureArray.pushMap(item)
      }
      event.putArray("gestures", gestureArray)
      event.putDouble("timestamp", timestamp.toDouble())
      if (timestamp - lastPreviewAt >= 800L) {
        val preview = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, 42, preview)
        event.putString("preview", Base64.encodeToString(preview.toByteArray(), Base64.NO_WRAP))
        lastPreviewAt = timestamp
      }
      reactApplicationContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit("MotionPlayFrame", event)
    } finally {
      bitmap.recycle()
    }
  }

  private fun readLine(input: InputStream): String? {
    val bytes = ByteArrayOutputStream()
    var previous = -1
    while (true) {
      val current = input.read()
      if (current < 0) return if (bytes.size() == 0) null else bytes.toString(Charsets.ISO_8859_1.name())
      if (previous == '\r'.code && current == '\n'.code) {
        return bytes.toString(Charsets.ISO_8859_1.name()).trimEnd('\r')
      }
      bytes.write(current)
      previous = current
    }
  }

  private fun readExactly(input: InputStream, length: Int): ByteArray? {
    val bytes = ByteArray(length)
    var offset = 0
    while (offset < length) {
      val count = input.read(bytes, offset, length - offset)
      if (count < 0) return null
      offset += count
    }
    return bytes
  }

  private fun emitStatus(state: String, message: String) {
    val payload: WritableMap = Arguments.createMap().apply { putString("state", state); putString("message", message) }
    reactApplicationContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit("MotionPlayStatus", payload)
  }

  private fun closeTasks() {
    runCatching { poseTask?.close() }
    runCatching { gestureTask?.close() }
    poseTask = null
    gestureTask = null
  }

  override fun invalidate() {
    stopStreamInternal()
    executor.shutdownNow()
    super.invalidate()
  }
}
