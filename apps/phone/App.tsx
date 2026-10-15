import React, { useEffect, useRef, useState } from 'react';
import { Pressable, SafeAreaView, StyleSheet, Text, TextInput, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import TcpSocket from 'react-native-tcp-socket';
import { Buffer } from 'buffer';

const STREAM_PORT = 8080;
const BOUNDARY = 'motionplayframe';
const FRAME_INTERVAL_MS = 500;

type Client = any;

export default function App() {
  const [permission, requestPermission] = useCameraPermissions();
  const [cameraReady, setCameraReady] = useState(false);
  const [running, setRunning] = useState(false);
  const [phoneIp, setPhoneIp] = useState('');
  const [clients, setClients] = useState(0);
  const [cameraError, setCameraError] = useState('');
  const cameraRef = useRef<CameraView>(null);
  const serverRef = useRef<any>(null);
  const clientsRef = useRef<Set<Client>>(new Set());
  const runningRef = useRef(false);
  const cameraReadyRef = useRef(false);
  const capturingRef = useRef(false);
  const frameTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => stopStream(), []);

  const stopStream = () => {
    runningRef.current = false;
    cameraReadyRef.current = false;
    setCameraReady(false);
    if (frameTimerRef.current) clearTimeout(frameTimerRef.current);
    frameTimerRef.current = null;
    for (const client of clientsRef.current) client.destroy();
    clientsRef.current.clear();
    setClients(0);
    serverRef.current?.close();
    serverRef.current = null;
    setRunning(false);
  };

  const startStream = async () => {
    if (!permission?.granted) {
      const result = await requestPermission();
      if (!result.granted) return;
    }
    const server = TcpSocket.createServer((client: Client) => {
      let request = '';
      const onRequest = (data: string | Buffer) => {
        request += data.toString();
        if (!request.includes('\r\n\r\n')) return;
        client.removeListener('data', onRequest);
        if (!request.startsWith('GET /video ')) {
          client.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
          return;
        }
        clientsRef.current.add(client);
        setClients(clientsRef.current.size);
        client.write(`HTTP/1.1 200 OK\r\nConnection: keep-alive\r\nCache-Control: no-store, no-cache, must-revalidate\r\nPragma: no-cache\r\nContent-Type: multipart/x-mixed-replace; boundary=${BOUNDARY}\r\n\r\n`);
        client.on('close', removeClient);
        client.on('error', removeClient);
      };
      const removeClient = () => {
        clientsRef.current.delete(client);
        setClients(clientsRef.current.size);
      };
      client.on('data', onRequest);
      client.on('error', removeClient);
    }).listen({ port: STREAM_PORT, host: '0.0.0.0', reuseAddress: true });
    server.on('error', () => stopStream());
    serverRef.current = server;
    runningRef.current = true;
    setRunning(true);

    const captureAndBroadcast = async () => {
      if (!runningRef.current) return;
      if (!capturingRef.current && cameraReadyRef.current && clientsRef.current.size > 0 && cameraRef.current) {
        capturingRef.current = true;
        try {
          const picture = await cameraRef.current.takePictureAsync({ quality: 0.4, base64: true, skipProcessing: true });
          if (picture.base64 && runningRef.current) {
            const jpeg = Buffer.from(picture.base64, 'base64');
            const header = Buffer.from(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
            const trailer = Buffer.from('\r\n');
            for (const client of clientsRef.current) {
              try { client.write(header); client.write(jpeg); client.write(trailer); } catch { clientsRef.current.delete(client); }
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn('MoveQuest camera frame capture failed:', message);
          setCameraError(message);
        }
        finally { capturingRef.current = false; }
      }
      frameTimerRef.current = setTimeout(captureAndBroadcast, FRAME_INTERVAL_MS);
    };
    captureAndBroadcast();
  };

  return (
    <SafeAreaView style={styles.root}>
      {running && permission?.granted && <CameraView ref={cameraRef} style={styles.preview} facing="front" pictureSize="640x480" onCameraReady={() => { cameraReadyRef.current = true; setCameraReady(true); }} />}
      <View style={styles.content}>
        <Text style={styles.logo}>motion<Text style={styles.accent}>play</Text></Text>
        <Text style={styles.eyebrow}>PRIVATE LOCAL CAMERA</Text>
        <Text style={styles.title}>Your phone is the camera.{ '\n' }The TV does the thinking.</Text>
        <Text style={styles.copy}>Keep this screen open. MoveQuest TV receives the live camera stream and runs pose and hand detection on the TV. Video stays on your home Wi-Fi.</Text>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{running ? 'CAMERA STREAM READY' : 'CAMERA STREAM OFF'}</Text>
          {running && <TextInput value={phoneIp} onChangeText={setPhoneIp} placeholder="Phone Wi-Fi IP, e.g. 192.168.1.20" placeholderTextColor="#788071" keyboardType="decimal-pad" style={styles.ipInput} />}
          <Text style={styles.url}>{running ? `http://${phoneIp || '<phone-ip>'}:${STREAM_PORT}/video` : 'Start the stream, then enter this URL in MoveQuest TV.'}</Text>
          <Text style={styles.status}>{running ? `${clients} TV connection${clients === 1 ? '' : 's'} · ${cameraReady ? 'camera ready' : 'opening camera…'}` : 'Phone and TV must share the same Wi-Fi network.'}</Text>
          {!!cameraError && <Text style={styles.error}>Camera frame error: {cameraError}</Text>}
        </View>
        <Pressable onPress={running ? stopStream : startStream} style={styles.button}><Text style={styles.buttonText}>{running ? 'STOP CAMERA STREAM' : permission?.granted ? 'START CAMERA STREAM' : 'ALLOW CAMERA & START'}</Text></Pressable>
        <Text style={styles.note}>Find your phone IP in Android Settings → Wi‑Fi → connected network. Both devices must be on the same network. Keep this app in the foreground.</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#111410' },
  preview: { position: 'absolute', top: 0, left: 0, width: 360, height: 270, opacity: 0.12 },
  content: { flex: 1, padding: 24, justifyContent: 'center', gap: 12 },
  logo: { color: '#F2F2EC', fontSize: 23, fontWeight: '900' }, accent: { color: '#B9F46A' },
  eyebrow: { color: '#B9F46A', fontSize: 10, fontWeight: '900', letterSpacing: 2 },
  title: { color: '#F3F2EA', fontSize: 28, lineHeight: 33, fontWeight: '900' },
  copy: { color: '#A5AD9E', fontSize: 13, lineHeight: 19 },
  card: { backgroundColor: '#1A1F18', borderColor: '#343C31', borderWidth: 1, borderRadius: 14, padding: 15, gap: 8, marginTop: 5 },
  cardTitle: { color: '#DDF8BF', fontSize: 11, fontWeight: '900', letterSpacing: 1 },
  url: { color: '#F3F2EA', fontSize: 12, fontWeight: '800' }, ipInput: { color: '#F3F2EA', backgroundColor: '#111410', borderWidth: 1, borderColor: '#3A4336', borderRadius: 8, paddingHorizontal: 10, height: 38, fontSize: 11 }, status: { color: '#929B8B', fontSize: 10 }, error: { color: '#FF9B82', fontSize: 10 },
  button: { height: 48, borderRadius: 12, backgroundColor: '#B9F46A', alignItems: 'center', justifyContent: 'center', marginTop: 3 },
  buttonText: { color: '#182014', fontSize: 11, fontWeight: '900', letterSpacing: 0.7 },
  note: { color: '#788071', fontSize: 10, lineHeight: 15 },
});
