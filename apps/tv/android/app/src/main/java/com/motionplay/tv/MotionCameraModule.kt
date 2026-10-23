package com.motionplay.tv

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.os.SystemClock
import android.util.Base64
import android.util.Log
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
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

class MotionCameraModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private val executor = Executors.newSingleThreadExecutor()
  private val inferenceExecutor = Executors.newSingleThreadExecutor()
  private val active = AtomicBoolean(false)
  private val generation = AtomicInteger(0)
  @Volatile private var streamTask: Future<*>? = null
  @Volatile private var activeConnection: HttpURLConnection? = null
  @Volatile private var poseTask: PoseLandmarker? = null
  @Volatile private var gestureTask: GestureRecognizer? = null
  @Volatile private var lastPreviewAt = 0L
  @Volatile private var rotationMode = context.getSharedPreferences("camera", 0).getInt("rotation", -1)
  @Volatile private var rotationDegrees = if (rotationMode >= 0) rotationMode else 0
  @Volatile private var orientationLocked = rotationMode >= 0
  private val rotationEpoch = AtomicInteger(0)
  private var lastGestureAt = 0L
  private var checkedExif = false

  override fun getName() = "MotionCamera"

  @ReactMethod
  fun addListener(eventName: String) { }

  @ReactMethod
  fun removeListeners(count: Int) { }

  @ReactMethod
  fun savedStreamUrl(promise: Promise) {
    promise.resolve(reactApplicationContext.getSharedPreferences("camera", 0).getString("url", ""))
  }

  @ReactMethod
  fun setCameraRotation(degrees: Int, promise: Promise) {
    if (degrees !in listOf(-1, 0, 90, 180, 270)) { promise.reject("ROTATION", "Use auto, 0, 90, 180 or 270 degrees."); return }
    rotationMode = degrees
    rotationDegrees = if (degrees < 0) 0 else degrees
    orientationLocked = degrees >= 0
    rotationEpoch.incrementAndGet()
    reactApplicationContext.getSharedPreferences("camera", 0).edit().putInt("rotation", degrees).apply()
    promise.resolve(true)
  }

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
    val token = generation.incrementAndGet()
    emitStatus("CONNECTING", "Connecting to phone camera…")
    streamTask = executor.submit {
      var connection: HttpURLConnection? = null
      var inference: Future<*>? = null
      val latest = AtomicReference<ByteArray?>(null)
      try {
        if (generation.get() != token) return@submit
        orientationLocked = rotationMode >= 0
        rotationDegrees = if (rotationMode >= 0) rotationMode else 0
        checkedExif = false
        connection = (parsed.openConnection() as HttpURLConnection).apply {
          connectTimeout = 6000
          readTimeout = 8000
          setRequestProperty("Accept", "multipart/x-mixed-replace")
          setRequestProperty("User-Agent", "MotionPlay-TV/1.0")
        }
        activeConnection = connection
        connection.connect()
        if (generation.get() != token) return@submit
        if (connection.responseCode !in 200..299) throw IllegalStateException("Camera returned HTTP ${connection.responseCode}")
        val contentType = connection.contentType ?: ""
        if (!contentType.contains("multipart", ignoreCase = true)) {
          throw IllegalStateException("URL is reachable, but it is not a multipart MJPEG stream (Content-Type: $contentType)")
        }
        val boundaryHeader = contentType.substringAfter("boundary=", "").trim().trim('"')
        if (boundaryHeader.isBlank()) throw IllegalStateException("MJPEG response did not specify a boundary")
        val boundary = if (boundaryHeader.startsWith("--")) boundaryHeader else "--$boundaryHeader"
        reactApplicationContext.getSharedPreferences("camera", 0).edit().putString("url", streamUrl).apply()
        emitStatus("CONNECTED", "Camera connected · detection runs on this TV")
        inference = inferenceExecutor.submit {
          try {
            initializeTasks()
            while (active.get() && generation.get() == token && !Thread.currentThread().isInterrupted) {
              val jpeg = latest.getAndSet(null)
              if (jpeg == null) Thread.sleep(15) else processJpeg(jpeg, SystemClock.elapsedRealtime(), token)
            }
          } catch (error: InterruptedException) {
            Thread.currentThread().interrupt()
          } catch (error: Throwable) {
            if (active.get() && generation.get() == token) {
              emitStatus("ERROR", error.message ?: "Pose inference failed")
              active.set(false)
              activeConnection?.disconnect()
            }
          } finally { closeTasks() }
        }
        readMjpeg(BufferedInputStream(connection.inputStream), boundary, token, latest)
        if (active.get() && generation.get() == token) throw IllegalStateException("Camera stream ended")
      } catch (error: Throwable) {
        if (active.get() && generation.get() == token) emitStatus("ERROR", error.message ?: "Could not read the camera stream")
      } finally {
        if (generation.get() == token) active.set(false)
        connection?.disconnect()
        if (activeConnection === connection) activeConnection = null
        inference?.cancel(true)
        latest.set(null)
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
    generation.incrementAndGet()
    active.set(false)
    activeConnection?.disconnect()
    activeConnection = null
    streamTask?.cancel(true)
    streamTask = null
    // Models are closed by the stream worker after inference exits, never mid-frame.
  }

  private fun initializeTasks() {
    val poseOptions = PoseLandmarker.PoseLandmarkerOptions.builder()
      .setBaseOptions(BaseOptions.builder().setModelAssetPath("pose_landmarker_lite.task").build())
      .setRunningMode(RunningMode.VIDEO)
      .setNumPoses(4)
      .setMinPoseDetectionConfidence(0.45f)
      .setMinPosePresenceConfidence(0.45f)
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

  private fun readMjpeg(input: BufferedInputStream, boundary: String, token: Int, latest: AtomicReference<ByteArray?>) {
    var lastCommandId = 0L
    var partLine = readLine(input)
    while (active.get() && generation.get() == token && partLine != null) {
      if (!partLine.startsWith(boundary)) {
        partLine = readLine(input)
        continue
      }
      var length = -1
      var commandId = 0L
      var command = ""
      while (true) {
        val header = readLine(input) ?: return
        if (header.isEmpty()) break
        if (header.startsWith("Content-Length:", ignoreCase = true)) length = header.substringAfter(':').trim().toIntOrNull() ?: -1
        if (header.startsWith("X-MoveQuest-Command-Id:", ignoreCase = true)) commandId = header.substringAfter(':').trim().toLongOrNull() ?: 0L
        if (header.startsWith("X-MoveQuest-Command:", ignoreCase = true)) command = header.substringAfter(':').trim().take(200)
      }
      if (length <= 0 || length > 4_000_000) throw IllegalStateException("Invalid MJPEG frame length ($length); use an IP Webcam JPEG/MJPEG stream")
      val jpeg = readExactly(input, length) ?: return
      readLine(input) // CRLF after JPEG bytes.
      if (commandId > lastCommandId && command.isNotBlank() && generation.get() == token && active.get()) {
        lastCommandId = commandId
        runCatching {
          val text = String(Base64.decode(command, Base64.DEFAULT), Charsets.UTF_8).take(100)
          val payload = Arguments.createMap().apply { putString("text", text); putDouble("id", commandId.toDouble()) }
          reactApplicationContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit("MotionPlayCommand", payload)
        }
      }
      latest.set(jpeg) // Bounded mailbox: inference consumes the newest frame, never a backlog.
      partLine = readLine(input)
    }
  }

  private fun processJpeg(bytes: ByteArray, timestamp: Long, token: Int) {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    var sample = 1
    while (bounds.outWidth / sample > 640 || bounds.outHeight / sample > 480) sample *= 2
    val raw = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample; inPreferredConfig = Bitmap.Config.ARGB_8888 }) ?: return
    val epoch = rotationEpoch.get()
    if (rotationMode < 0 && !checkedExif) {
      checkedExif = true
      rotationDegrees = runCatching {
        when (ExifInterface(ByteArrayInputStream(bytes)).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
          ExifInterface.ORIENTATION_ROTATE_90, ExifInterface.ORIENTATION_TRANSPOSE -> 90
          ExifInterface.ORIENTATION_ROTATE_180 -> 180
          ExifInterface.ORIENTATION_ROTATE_270, ExifInterface.ORIENTATION_TRANSVERSE -> 270
          else -> 0
        }
      }.getOrDefault(0)
    }
    val rotation = rotationDegrees
    val bitmap = if (rotation == 0) raw else Bitmap.createBitmap(raw, 0, 0, raw.width, raw.height, Matrix().apply { postRotate(rotation.toFloat()) }, true)
    try {
      val image = BitmapImageBuilder(bitmap).build()
      val poses = poseTask?.detectForVideo(image, timestamp)
      val hands = if (orientationLocked && timestamp - lastGestureAt >= 1000L) {
        lastGestureAt = timestamp
        gestureTask?.recognizeForVideo(image, timestamp)
      } else null
      if (rotationMode < 0 && !orientationLocked && rotationEpoch.get() == epoch) {
        val upright = poses?.landmarks()?.any { p ->
          if (p.size < 29) false else {
            val shoulders = listOf(p[11], p[12]).filter { it.visibility().orElse(0f) >= 0.4f }
            val hips = listOf(p[23], p[24]).filter { it.visibility().orElse(0f) >= 0.4f }
            if (shoulders.isEmpty() || hips.isEmpty()) false else {
              val dx = (hips.map { it.x().toDouble() }.average() - shoulders.map { it.x().toDouble() }.average()) * bitmap.width / bitmap.height
              val dy = hips.map { it.y().toDouble() }.average() - shoulders.map { it.y().toDouble() }.average()
              dy > 0.08 && dy > kotlin.math.abs(dx) * 0.8
            }
          }
        } ?: false
        if (upright) orientationLocked = true else rotationDegrees = (rotation + 90) % 360
      }
      val event = Arguments.createMap()
      event.putInt("rotationDegrees", rotation)
      event.putBoolean("orientationLocked", orientationLocked)
      event.putDouble("inferenceMs", (SystemClock.elapsedRealtime() - timestamp).toDouble())
      event.putBoolean("gesturesUpdated", hands != null)
      event.putDouble("imageWidth", bitmap.width.toDouble())
      event.putDouble("imageHeight", bitmap.height.toDouble())
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
      if (timestamp - lastPreviewAt >= 200L) {
        val preview = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, 42, preview)
        event.putString("preview", Base64.encodeToString(preview.toByteArray(), Base64.NO_WRAP))
        lastPreviewAt = timestamp
      }
      Log.i("MoveQuestInference", "rotation=$rotation locked=$orientationLocked poses=${poses?.landmarks()?.size ?: 0} ms=${SystemClock.elapsedRealtime() - timestamp}")
      if (active.get() && generation.get() == token && rotationEpoch.get() == epoch) reactApplicationContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit("MotionPlayFrame", event)
    } finally {
      bitmap.recycle()
      if (raw !== bitmap) raw.recycle()
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
    inferenceExecutor.shutdownNow()
    super.invalidate()
  }
}
