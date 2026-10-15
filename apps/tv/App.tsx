import React, { useEffect, useRef, useState } from 'react';
import { BackHandler, Image, NativeEventEmitter, NativeModules, Pressable, ScrollView, StatusBar, StyleSheet, Text, TextInput, View } from 'react-native';
import { exerciseCue, exerciseRepStep, poseCenterX, poseMotion, type ExerciseId, type Landmark, type RepPhase } from '@motionplay/game-kit';

type Screen = 'home' | 'workout' | 'games' | 'session' | 'results';
type Session = { title: string; subtitle: string; kind: 'workout' | 'game'; color: string; emoji: string };
type PosePlayer = { id: string; centerX: number; reps: number; phase: RepPhase; activeFrames: number; lastRepAt: number; movement: 'moving' | 'still'; previous: Landmark[]; lastSeen: number };
type NativeFrame = { poses: Landmark[][]; gestures: Array<{ gesture: string; score: number; x: number; y: number }>; preview?: string };

const workouts: Session[] = [
  { title: 'Squat challenge', subtitle: 'Bend with control, then stand tall', kind: 'workout', color: '#B9F46A', emoji: '⚡' },
  { title: 'Jumping jacks', subtitle: 'Arms up · feet apart · close', kind: 'workout', color: '#FFB86B', emoji: '♫' },
  { title: 'Arm raises', subtitle: 'Reach up, then lower with control', kind: 'workout', color: '#83D9D2', emoji: '✦' },
];
const games: Session[] = [
  { title: 'Freeze Dance', subtitle: 'Move when prompted. Freeze on cue.', kind: 'game', color: '#EBA6FF', emoji: '♪' },
  { title: 'Mimic the Pose', subtitle: 'Copy the pose and hold it', kind: 'game', color: '#8FBCFF', emoji: '◉' },
  { title: 'Gesture Trivia', subtitle: 'Answer with point or swipe gestures', kind: 'game', color: '#FF9D9D', emoji: '?' },
];
const { MotionCamera } = NativeModules;
const cameraEvents = MotionCamera ? new NativeEventEmitter(MotionCamera) : null;

function Action({ title, hint, onPress, primary = false }: { title: string; hint: string; onPress: () => void; primary?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityHint={hint} onPress={onPress} style={({ focused, pressed }) => [styles.action, primary && styles.primaryAction, (focused || pressed) && styles.actionFocused]}><Text style={[styles.actionTitle, primary && styles.primaryText]}>{title}</Text><Text style={[styles.actionHint, primary && styles.primaryText]}>{hint}</Text></Pressable>;
}
function Card({ item, onPress }: { item: Session; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={item.title} accessibilityHint={`${item.subtitle}. Open session.`} onPress={onPress} style={({ focused, pressed }) => [styles.card, { borderColor: item.color }, (focused || pressed) && styles.cardFocused]}><View accessible={false} style={[styles.cardIcon, { backgroundColor: item.color }]}><Text style={styles.cardEmoji}>{item.emoji}</Text></View><Text style={styles.cardTitle}>{item.title}</Text><Text style={styles.cardSub}>{item.subtitle}</Text><Text style={[styles.cardOpen, { color: item.color }]}>OPEN SESSION  ›</Text></Pressable>;
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('home');
  const [selected, setSelected] = useState<Session>(workouts[0]);
  const [exercise, setExercise] = useState<ExerciseId>('squat');
  const [streamUrl, setStreamUrl] = useState('');
  const [cameraState, setCameraState] = useState('DISCONNECTED');
  const [cameraMessage, setCameraMessage] = useState('Enter the phone camera MJPEG URL');
  const [preview, setPreview] = useState('');
  const [players, setPlayers] = useState<PosePlayer[]>([]);
  const [seconds, setSeconds] = useState(45);
  const [phase, setPhase] = useState<'READY' | 'MOVE' | 'FREEZE'>('READY');
  const [paused, setPaused] = useState(false);
  const [gestureFeedback, setGestureFeedback] = useState('');
  const playersRef = useRef(new Map<string, PosePlayer>());
  const nextPlayerId = useRef(1);
  const candidate = useRef({ name: '', since: 0, lastSeen: 0, samples: 0, fired: false });
  const previousHand = useRef<{ x: number; at: number } | null>(null);
  const lastGestureAction = useRef(0);
  const pausedRef = useRef(false);
  const selectedRef = useRef<Session>(workouts[0]);

  const reps = players.reduce((sum, player) => sum + player.reps, 0);
  const allStill = players.every(player => player.movement === 'still');

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (screen === 'home') return false;
      setScreen('home');
      return true;
    });
    return () => sub.remove();
  }, [screen]);

  useEffect(() => {
    if (!cameraEvents) return;
    const statusSub = cameraEvents.addListener('MotionPlayStatus', (event: { state: string; message: string }) => {
      setCameraState(event.state);
      setCameraMessage(event.message);
      if (event.state === 'STOPPED' || event.state === 'ERROR') setPreview('');
    });
    const frameSub = cameraEvents.addListener('MotionPlayFrame', (event: NativeFrame) => {
      if (event.preview) setPreview(event.preview);
      const detections = (event.poses ?? []).map(landmarks => ({ landmarks, centerX: poseCenterX(landmarks) }))
        .filter((pose): pose is { landmarks: Landmark[]; centerX: number } => pose.centerX !== null)
        .sort((a, b) => a.centerX - b.centerX).slice(0, 4);
      const now = Date.now();
      const tracks = playersRef.current;
      const usedIds = new Set<string>();
      for (const detection of detections) {
        let best: PosePlayer | undefined;
        let nearest = 0.2;
        for (const track of tracks.values()) {
          const distance = Math.abs(track.centerX - detection.centerX);
          if (!usedIds.has(track.id) && track.lastSeen > now - 1600 && distance < nearest) { best = track; nearest = distance; }
        }
        if (!best) {
          best = { id: `player-${nextPlayerId.current++}`, centerX: detection.centerX, reps: 0, phase: 'ready', activeFrames: 0, lastRepAt: 0, movement: 'still', previous: [], lastSeen: now };
          tracks.set(best.id, best);
        }
        if (now - best.lastSeen > 700) { best.phase = 'ready'; best.activeFrames = 0; best.previous = []; }
        usedIds.add(best.id);
        best.centerX = detection.centerX;
        best.lastSeen = now;
        const step = selectedRef.current.kind === 'workout'
          ? exerciseRepStep(exercise, detection.landmarks, best.phase)
          : { phase: 'ready' as RepPhase, rep: false };
        best.phase = step.phase;
        if (step.phase === 'active') best.activeFrames++;
        else {
          if (step.rep && best.activeFrames >= 1 && now - best.lastRepAt >= 850) { best.reps++; best.lastRepAt = now; }
          best.activeFrames = 0;
        }
        if (best.previous.length) best.movement = poseMotion(best.previous, detection.landmarks) > 0.014 ? 'moving' : 'still';
        best.previous = detection.landmarks;
      }
      for (const [id, track] of tracks) if (track.lastSeen < now - 2200) tracks.delete(id);
      setPlayers([...tracks.values()].filter(track => track.lastSeen > now - 900));
      handleGestures(event.gestures ?? [], now);
    });
    return () => { statusSub.remove(); frameSub.remove(); };
  // exercise is intentionally current so a selected movement changes TV-side scoring immediately.
  }, [exercise]);

  useEffect(() => {
    if (screen !== 'session' || paused) return;
    const timer = setInterval(() => {
      setSeconds(value => {
        if (value <= 1) { clearInterval(timer); setScreen('results'); return 0; }
        return value - 1;
      });
      setPhase(value => value === 'READY' ? 'MOVE' : value === 'MOVE' ? 'FREEZE' : 'MOVE');
    }, 1000);
    return () => clearInterval(timer);
  }, [screen, paused]);

  const handleGestures = (hands: NativeFrame['gestures'], now: number) => {
    const hand = hands.filter(item => item.score >= 0.58).sort((a, b) => b.score - a.score)[0];
    if (!hand) {
      if (candidate.current.name && now - candidate.current.lastSeen > 650) candidate.current = { name: '', since: 0, lastSeen: 0, samples: 0, fired: false };
      previousHand.current = null;
      return;
    }
    const prev = previousHand.current;
    if (prev && now - prev.at < 700 && Math.abs(hand.x - prev.x) > 0.24) {
      const direction = hand.x > prev.x ? 'RIGHT' : 'LEFT';
      setGestureFeedback(`Swipe ${direction.toLowerCase()} detected · answer ${direction.toLowerCase()}`);
      if (selectedRef.current.title === 'Gesture Trivia') setPhase(direction === 'LEFT' ? 'READY' : 'MOVE');
    }
    previousHand.current = { x: hand.x, at: now };
    if (candidate.current.name !== hand.gesture) candidate.current = { name: hand.gesture, since: now, lastSeen: now, samples: 1, fired: false };
    else { candidate.current.lastSeen = now; candidate.current.samples++; }
    const current = candidate.current;
    if (!current.fired && current.samples >= 2 && now - current.since >= 350) {
      current.fired = true;
      if (hand.gesture === 'Open_Palm' || hand.gesture === 'Closed_Fist') {
        if (now - lastGestureAction.current > 900) {
          lastGestureAction.current = now;
          const next = !pausedRef.current;
          pausedRef.current = next;
          setPaused(next);
          setGestureFeedback(next ? 'Open palm / fist · paused' : 'Gesture · resumed');
        }
      } else if (hand.gesture === 'Victory') {
        setGestureFeedback('Victory sign · next challenge');
        setScreen('results');
      } else if (hand.gesture === 'Thumb_Up') setGestureFeedback('Thumbs up · great work!');
      else if (hand.gesture === 'Thumb_Down') setGestureFeedback('Thumbs down · try that again');
      else if (hand.gesture === 'Pointing_Up') setGestureFeedback('Pointing up · answer locked in');
      else if (hand.gesture === 'ILoveYou') setGestureFeedback('I Love You sign · bonus cheer!');
    }
  };

  const connectCamera = async () => {
    if (!MotionCamera) { setCameraState('ERROR'); setCameraMessage('TV inference module is not included in this build. Rebuild the native Android app.'); return; }
    try { await MotionCamera.startStream(streamUrl.trim()); }
    catch (error) { setCameraState('ERROR'); setCameraMessage(String(error)); }
  };
  const disconnectCamera = async () => { await MotionCamera?.stopStream(); setCameraState('STOPPED'); };
  const start = (item: Session) => {
    selectedRef.current = item;
    setSelected(item);
    if (item.title === 'Jumping jacks') setExercise('jumping-jacks');
    else if (item.title === 'Arm raises') setExercise('arm-raises');
    else setExercise('squat');
    setPlayers([]); playersRef.current.clear(); nextPlayerId.current = 1;
    setGestureFeedback(''); setPaused(false); pausedRef.current = false;
    setSeconds(item.kind === 'game' ? 30 : 45); setPhase(item.kind === 'game' ? 'MOVE' : 'READY'); setScreen('session');
    if (cameraState !== 'CONNECTED' && streamUrl.trim()) void connectCamera();
  };

  const cue = players.length ? exerciseCue(exercise, players[0].previous) : 'Frame your whole body in the phone camera';
  const exerciseName = exercise === 'squat' ? 'SQUATS' : exercise === 'jumping-jacks' ? 'JUMPING JACKS' : 'ARM RAISES';

  return <View style={styles.root}><StatusBar hidden />
    <View style={styles.topbar}><Image accessible={false} source={require('./assets/motionplay-icon.png')} style={{ width: 30, height: 30, borderRadius: 8 }} /><Text accessibilityRole="header" style={styles.brand}>Move<Text style={{ color: '#B9F46A' }}>Quest</Text></Text><Text style={styles.tag}>ON-TV COMPUTER VISION · LOCAL CAMERA</Text><View accessibilityLiveRegion="polite" style={styles.live}><View style={[styles.dot, cameraState !== 'CONNECTED' && { backgroundColor: cameraState === 'CONNECTING' ? '#FFB86B' : '#737A6F' }]} /><Text style={styles.liveText}>{cameraState === 'CONNECTED' ? 'TV INFERENCE ACTIVE' : cameraState}</Text></View></View>
    {screen === 'home' && <ScrollView accessibilityLabel="MoveQuest home. Scroll for workouts and games." contentContainerStyle={styles.page} showsVerticalScrollIndicator={false}>
      <View style={styles.hero}><View style={styles.heroCopy}><Text style={styles.eyebrow}>YOUR LIVING ROOM, IN MOTION</Text><Text style={styles.heroTitle}>A little movement.{ '\n' }A lot of fun.</Text><Text style={styles.heroDesc}>Phone sends camera video. This Fire TV app runs pose and hand detection, scores movement, and shows every result here.</Text><Action title="START A WORKOUT" hint="45 sec demo session" primary onPress={() => start(workouts[0])} /></View><View style={styles.heroArt}><Text style={styles.heroSpark}>✳</Text><View style={styles.orbit}><Text style={styles.figure}>🕺</Text></View><Text style={styles.artLabel}>AI RUNS ON THIS TV</Text></View></View>
      <View style={styles.cameraCard}><View style={styles.cameraCopy}><Text style={styles.cardTitle}>CONNECT YOUR PHONE CAMERA</Text><Text style={styles.cardSub}>In the phone app, start the camera stream and enter its shown URL here. Both devices must share Wi‑Fi.</Text><Text accessibilityLiveRegion="polite" style={styles.cameraStatus}>{cameraMessage}</Text></View><TextInput accessibilityLabel="Phone camera stream URL" accessibilityHint="Enter the MJPEG URL shown in the phone camera app" value={streamUrl} onChangeText={setStreamUrl} placeholder="http://192.168.1.20:8080/video" placeholderTextColor="#788071" autoCapitalize="none" autoCorrect={false} style={styles.input} /><Action title={cameraState === 'CONNECTED' ? 'DISCONNECT CAMERA' : 'CONNECT CAMERA'} hint="MJPEG · local Wi‑Fi" primary={cameraState !== 'CONNECTED'} onPress={() => cameraState === 'CONNECTED' ? void disconnectCamera() : void connectCamera()} /></View>
      <View style={styles.rowHead}><Text style={styles.sectionTitle}>Pick your vibe</Text><Text style={styles.sectionHint}>Use the remote to choose</Text></View>
      <View style={styles.cards}>{workouts.slice(0, 2).map(item => <Card key={item.title} item={item} onPress={() => start(item)} />)}{games.slice(0, 1).map(item => <Card key={item.title} item={item} onPress={() => start(item)} />)}</View>
      <View style={styles.bottomNote}><Text style={styles.noteIcon}>◉</Text><Text style={styles.noteText}>Phone = camera only · Fire TV = MediaPipe inference, rep tracking, and gestures. No cloud upload.</Text><Action title="ALL GAMES" hint="3 ways to play" onPress={() => setScreen('games')} /></View>
    </ScrollView>}
    {screen === 'workout' && <Library title="Workouts" items={workouts} onChoose={start} onBack={() => setScreen('home')} />}
    {screen === 'games' && <Library title="Play together" items={games} onChoose={start} onBack={() => setScreen('home')} />}
    {screen === 'session' && <View style={styles.session}><View style={styles.sessionTop}><Text style={styles.eyebrow}>{selected.kind === 'game' ? 'FAMILY GAME' : `FOLLOW THE COACH · ${exerciseName}`}</Text><Text style={styles.sessionTitle}>{selected.title}</Text><Text style={styles.timer}>{paused ? 'PAUSED' : `00:${String(seconds).padStart(2, '0')}`}</Text></View><View style={styles.stage}>{preview ? <Image source={{ uri: `data:image/jpeg;base64,${preview}` }} resizeMode="contain" style={styles.preview} /> : <View style={styles.stageGlow} />}<View style={styles.stageOverlay}><Text style={styles.prompt}>{selected.kind === 'game' ? phase : reps ? 'NICE WORK!' : 'FOLLOW THE MOVEMENT'}</Text><Text style={styles.instruction}>{selected.kind === 'game' ? (phase === 'FREEZE' ? (players.length && !allStill ? 'Caught moving!' : 'Hold still!') : 'Keep moving!') : cue}</Text></View><View style={styles.playerBadge}><Text style={styles.playerNumber}>{players.length}</Text><Text style={styles.metricLabel}>PLAYERS</Text></View></View><View style={styles.metrics}><View><Text style={styles.metricValue}>{String(reps).padStart(2, '0')}</Text><Text style={styles.metricLabel}>GROUP REPS · {players.length} TRACKED</Text></View><View style={styles.metricDivider} /><View style={{ flex: 1 }}><Text style={styles.metricLabel}>TV CAMERA · {cameraState}</Text><View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${Math.max(4, (45 - seconds) / 45 * 100)}%` }]} /></View><Text style={styles.feedback}>{gestureFeedback || (paused ? 'Open palm or closed fist to resume' : cue)}</Text></View><Action title={paused ? 'RESUME' : 'PAUSE'} hint="Remote control" onPress={() => { pausedRef.current = !paused; setPaused(pausedRef.current); }} /><Action title="FINISH" hint="End session" onPress={() => setScreen('results')} /></View></View>}
    {screen === 'results' && <View style={styles.results}><Text style={styles.eyebrow}>SESSION COMPLETE</Text><Text style={styles.resultsTitle}>You showed up.{ '\n' }That counts.</Text><Text style={styles.resultsSub}>Nice work with {selected.title.toLowerCase()}.</Text><View style={styles.resultStats}><Text style={styles.metricValue}>{reps}</Text><Text style={styles.metricLabel}>REPS LOGGED</Text><Text style={styles.resultBadge}>✦  GREAT ENERGY</Text></View><Action title="BACK TO HOME" hint="Pick another activity" primary onPress={() => setScreen('home')} /></View>}
  </View>;
}

function Library({ title, items, onChoose, onBack }: { title: string; items: Session[]; onChoose: (item: Session) => void; onBack: () => void }) {
  return <View style={styles.library}><Text style={styles.eyebrow}>MOVEQUEST LIBRARY</Text><Text style={styles.libraryTitle}>{title}</Text><Text style={styles.librarySub}>Pick a session and get moving.</Text><View style={styles.cards}>{items.map(item => <Card key={item.title} item={item} onPress={() => onChoose(item)} />)}</View><Action title="BACK" hint="Home" onPress={onBack} /></View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#111410' }, topbar: { height: 64, paddingHorizontal: 52, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#282D27', gap: 22 }, brand: { color: '#F2F2EC', fontSize: 26, fontWeight: '900' }, tag: { color: '#7D8477', fontSize: 9, letterSpacing: 1.7, flex: 1 }, live: { flexDirection: 'row', alignItems: 'center', gap: 8 }, dot: { width: 8, height: 8, borderRadius: 8, backgroundColor: '#B9F46A' }, liveText: { color: '#ADB4A7', fontSize: 9, letterSpacing: 0.8 }, page: { paddingHorizontal: 52, paddingTop: 20, paddingBottom: 24 }, hero: { minHeight: 228, backgroundColor: '#20271E', borderRadius: 20, padding: 25, flexDirection: 'row', overflow: 'hidden', borderWidth: 1, borderColor: '#333B30' }, heroCopy: { flex: 1, justifyContent: 'center', zIndex: 2 }, eyebrow: { color: '#B9F46A', fontSize: 9, fontWeight: '800', letterSpacing: 2 }, heroTitle: { color: '#F4F2E9', fontSize: 34, lineHeight: 38, fontWeight: '900', marginTop: 9 }, heroDesc: { color: '#ACB3A5', fontSize: 12, lineHeight: 18, maxWidth: 430, marginTop: 8, marginBottom: 12 }, heroArt: { width: 230, alignItems: 'center', justifyContent: 'center' }, orbit: { width: 170, height: 170, borderRadius: 120, backgroundColor: '#B9F46A', justifyContent: 'center', alignItems: 'center' }, figure: { fontSize: 82 }, heroSpark: { position: 'absolute', right: 12, top: 8, color: '#EBA6FF', fontSize: 30 }, artLabel: { color: '#8E9A7D', fontSize: 8, letterSpacing: 1.6, marginTop: 8 }, action: { minWidth: 120, minHeight: 45, borderColor: '#40483D', borderWidth: 1, backgroundColor: '#1A1F18', paddingHorizontal: 13, paddingVertical: 8, borderRadius: 11, justifyContent: 'center', marginRight: 7 }, primaryAction: { backgroundColor: '#B9F46A', borderColor: '#B9F46A' }, actionFocused: { borderColor: '#F8F7F1', borderWidth: 3, transform: [{ scale: 1.04 }] }, actionTitle: { color: '#E9EEE4', fontSize: 11, fontWeight: '900', letterSpacing: 0.5 }, actionHint: { color: '#9AA391', fontSize: 8, marginTop: 3 }, primaryText: { color: '#182014' }, cameraCard: { flexDirection: 'row', alignItems: 'center', gap: 16, backgroundColor: '#191D18', borderWidth: 1, borderColor: '#343C31', borderRadius: 15, padding: 15, marginTop: 14 }, cameraCopy: { flex: 1 }, cameraStatus: { color: '#B9F46A', fontSize: 9, marginTop: 5 }, input: { width: 270, height: 42, color: '#F3F2EA', backgroundColor: '#111410', borderWidth: 1, borderColor: '#3A4336', borderRadius: 9, paddingHorizontal: 10, fontSize: 10 }, rowHead: { flexDirection: 'row', alignItems: 'baseline', gap: 14, marginTop: 19, marginBottom: 10 }, sectionTitle: { fontSize: 18, color: '#F4F2E9', fontWeight: '800' }, sectionHint: { color: '#757D70', fontSize: 10 }, cards: { flexDirection: 'row', gap: 12 }, card: { flex: 1, minHeight: 135, borderRadius: 14, borderWidth: 1, backgroundColor: '#191D18', padding: 13 }, cardFocused: { borderWidth: 3, transform: [{ scale: 1.025 }], backgroundColor: '#242A21' }, cardIcon: { height: 32, width: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginBottom: 8 }, cardEmoji: { fontSize: 18, color: '#182014' }, cardTitle: { color: '#F0F0E8', fontWeight: '800', fontSize: 14 }, cardSub: { color: '#92998D', fontSize: 9, marginTop: 4, minHeight: 21 }, cardOpen: { fontSize: 8, fontWeight: '900', letterSpacing: 0.8, marginTop: 6 }, bottomNote: { flexDirection: 'row', alignItems: 'center', gap: 9, marginTop: 10 }, noteIcon: { color: '#B9F46A', fontSize: 17 }, noteText: { color: '#868E80', fontSize: 9, flex: 1 }, library: { padding: 55, flex: 1, justifyContent: 'center' }, libraryTitle: { fontSize: 38, fontWeight: '900', color: '#F4F2E9', marginTop: 10 }, librarySub: { color: '#9AA391', marginTop: 6, marginBottom: 25 }, session: { flex: 1, paddingHorizontal: 52, paddingVertical: 17 }, sessionTop: { flexDirection: 'row', alignItems: 'center', gap: 18 }, sessionTitle: { color: '#F2F2EC', fontSize: 20, fontWeight: '800', flex: 1 }, timer: { color: '#B9F46A', fontSize: 22, fontWeight: '800' }, stage: { flex: 1, marginTop: 13, marginBottom: 12, borderRadius: 22, backgroundColor: '#20271E', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }, preview: { ...StyleSheet.absoluteFill, width: '100%', height: '100%' }, stageGlow: { width: 220, height: 220, borderRadius: 140, backgroundColor: '#35422D', position: 'absolute' }, stageOverlay: { position: 'absolute', bottom: 18, left: 18, right: 18, alignItems: 'center', backgroundColor: '#111410C9', padding: 10, borderRadius: 12 }, prompt: { color: '#B9F46A', fontSize: 23, fontWeight: '900', letterSpacing: 3 }, instruction: { color: '#F2F2EC', fontSize: 13, marginTop: 5, textAlign: 'center' }, playerBadge: { position: 'absolute', top: 12, left: 12, backgroundColor: '#111410D9', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, alignItems: 'center' }, playerNumber: { color: '#B9F46A', fontSize: 24, fontWeight: '900' }, metrics: { minHeight: 74, flexDirection: 'row', alignItems: 'center', gap: 18 }, metricValue: { color: '#F5F4EB', fontSize: 29, fontWeight: '900' }, metricLabel: { color: '#81897C', fontSize: 8, letterSpacing: 1.1, fontWeight: '800', marginTop: 2 }, metricDivider: { height: 45, width: 1, backgroundColor: '#343A31' }, progressTrack: { height: 6, backgroundColor: '#343A31', borderRadius: 8, marginTop: 7, marginRight: 15 }, progressFill: { height: 6, backgroundColor: '#B9F46A', borderRadius: 8 }, feedback: { color: '#A7AE9F', fontSize: 9, marginTop: 5 }, results: { flex: 1, padding: 70, justifyContent: 'center', alignItems: 'flex-start' }, resultsTitle: { fontSize: 44, lineHeight: 49, fontWeight: '900', color: '#F4F2E9', marginTop: 16 }, resultsSub: { color: '#A4AB9D', fontSize: 14, marginTop: 10 }, resultStats: { marginVertical: 24, flexDirection: 'row', alignItems: 'center', gap: 12 }, resultBadge: { color: '#B9F46A', borderColor: '#43533A', borderWidth: 1, padding: 9, borderRadius: 10, marginLeft: 10, fontSize: 9, fontWeight: '800' },
});
