import React, { useEffect, useRef, useState } from 'react';
import { AppState, BackHandler, Image, NativeEventEmitter, NativeModules, PermissionsAndroid, Pressable, ScrollView, StatusBar, Text, TextInput, View } from 'react-native';
import type { Landmark } from '@motionplay/game-kit';
import { activityTitles, answerTrivia, createSession, freezePhase, instructions, parseVoiceCommand, questions, suspendTracking, tickSession, updatePoses, TRACKING_TIMEOUT_MS, sessionClockRunning, type Activity } from '@motionplay/game-kit/coach';
import { styles } from './styles';

type Screen = 'home' | 'setup' | 'session' | 'results';
type Frame = { poses: Landmark[][]; gestures: Array<{ gesture: string; score: number; x: number }>; preview?: string; imageWidth?: number; imageHeight?: number; rotationDegrees?: number; orientationLocked?: boolean; inferenceMs?: number; gesturesUpdated?: boolean };
const { MotionCamera, CoachVoice } = NativeModules;
const workouts: Activity[] = ['squat', 'jumping-jacks', 'arm-raises'];
const games: Activity[] = ['freeze', 'mimic', 'trivia'];
const colors = ['#B9F46A', '#FFB86B', '#83D9D2'];
const subtitles: Record<Activity, string> = { squat: 'Depth, controlled rise and full repetitions', 'jumping-jacks': 'Coordinate arms and feet through a full cycle', 'arm-raises': 'Reach evenly overhead, then lower fully', freeze: 'Dance, freeze and score each round', mimic: 'Match a pose and hold for two seconds', trivia: 'Choose and confirm with gestures or the remote' };

function Action({ title, hint = '', onPress, primary = false }: { title: string; hint?: string; onPress: () => void; primary?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityHint={hint} onPress={onPress} style={({ focused, pressed }) => [styles.action, primary && styles.primaryAction, (focused || pressed) && styles.actionFocused]}><Text style={[styles.actionTitle, primary && styles.primaryText]}>{title}</Text>{!!hint && <Text style={[styles.actionHint, primary && styles.primaryText]}>{hint}</Text>}</Pressable>;
}
function Card({ activity, index, onPress }: { activity: Activity; index: number; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={activityTitles[activity]} accessibilityHint={subtitles[activity]} onPress={onPress} style={({ focused, pressed }) => [styles.card, { borderColor: colors[index] }, (focused || pressed) && styles.cardFocused]}><Text style={[styles.cardTitle, { color: colors[index] }]}>{activityTitles[activity]}</Text><Text style={styles.cardSub}>{subtitles[activity]}</Text><Text style={[styles.cardOpen, { color: colors[index] }]}>INSTRUCTIONS + START ›</Text></Pressable>;
}

export default function CoachApp() {
  const [screen, setScreen] = useState<Screen>('home');
  const screenRef = useRef<Screen>('home');
  const session = useRef(createSession('squat'));
  const [, redraw] = useState(0);
  const refresh = () => redraw(n => n + 1);
  const [streamUrl, setStreamUrl] = useState(''); const urlRef = useRef('');
  const [cameraState, setCameraState] = useState('DISCONNECTED'); const cameraRef = useRef('DISCONNECTED');
  const [cameraMessage, setCameraMessage] = useState('Start the phone camera stream, then enter its URL.');
  const [preview, setPreview] = useState(''); const [overlay, setOverlay] = useState<Landmark[][]>([]);
  const [rotation, setRotation] = useState(0); const [orientationReady, setOrientationReady] = useState(false); const [inferenceMs, setInferenceMs] = useState(0);
  const [aspect, setAspect] = useState(4 / 3); const lastFrame = useRef(0);
  const [paused, setPaused] = useState(false); const pausedRef = useRef(false); const foreground = useRef(true);
  const [voiceEnabled, setVoiceEnabled] = useState(true); const voiceEnabledRef = useRef(true);
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  const [voiceMessage, setVoiceMessage] = useState('Checking TV speech services…'); const listening = useRef(false);
  const lastSpoken = useRef({ text: '', at: 0 }); const [gestureMessage, setGestureMessage] = useState('');
  const gesture = useRef({ name: '', at: 0, seen: 0, fired: false, samples: 0 });
  const handStart = useRef<{ x: number; at: number } | null>(null); const lastSwipe = useRef(0);
  const callbacks = useRef({ onHands: (_hands: Frame['gestures']) => {}, onCommand: (_text: string) => {} });
  const go = (next: Screen) => { screenRef.current = next; setScreen(next); };
  const say = (text: string, urgent = false) => {
    const now = Date.now();
    if (!voiceEnabledRef.current || listening.current || !foreground.current || !text) return;
    if (!urgent && (now - lastSpoken.current.at < 6000 || (text === lastSpoken.current.text && now - lastSpoken.current.at < 16000))) return;
    lastSpoken.current = { text, at: now }; CoachVoice?.speak(text);
  };
  const pause = (value: boolean) => { pausedRef.current = value; setPaused(value); suspendTracking(session.current); if (value) CoachVoice?.silence(); say(value ? 'Paused.' : 'Resumed. Return to your starting position.', true); };
  const finish = () => { go('results'); CoachVoice?.stopListening(); listening.current = false; say(`Session complete. ${session.current.reps} repetitions and ${session.current.points} game points.`, true); };
  const home = () => { go('home'); suspendTracking(session.current); CoachVoice?.silence(); CoachVoice?.stopListening(); listening.current = false; };
  const choose = (activity: Activity) => { session.current = createSession(activity); pausedRef.current = false; setPaused(false); setGestureMessage(''); go('setup'); say(`${activityTitles[activity]}. ${instructions[activity]}`, true); };
  const connect = async () => {
    try {
      if (!MotionCamera) throw new Error('Camera inference is missing from this build.');
      let input = urlRef.current.trim();
      if (!input) throw new Error('Enter the camera URL shown on your phone.');
      if (!/^https?:\/\//i.test(input)) input = `http://${input}`;
      const url = new URL(input);
      if (url.protocol === 'https:') url.protocol = 'http:';
      if (url.protocol !== 'http:' || !url.hostname || url.username || url.password) throw new Error('Use a local HTTP camera URL.');
      if (url.pathname === '/' || !url.pathname) url.pathname = '/video';
      urlRef.current = url.toString(); setStreamUrl(urlRef.current);
      cameraRef.current = 'CONNECTING'; setCameraState('CONNECTING'); lastFrame.current = 0; setPreview(''); setOverlay([]);
      setCameraMessage('Connecting to the phone. Keep its camera stream open.'); suspendTracking(session.current);
      await MotionCamera.startStream(urlRef.current);
    } catch (error) { cameraRef.current = 'ERROR'; setCameraState('ERROR'); setCameraMessage(String(error)); }
  };
  const begin = () => {
    session.current = createSession(session.current.activity); pausedRef.current = false; setPaused(false); go('session');
    setGestureMessage(''); gesture.current = { name: '', at: 0, seen: 0, fired: false, samples: 0 }; handStart.current = null;
    say(instructions[session.current.activity], true);
    if (cameraRef.current !== 'CONNECTED' && urlRef.current.trim()) void connect();
  };
  const confirm = () => { if (screenRef.current === 'session' && !pausedRef.current && answerTrivia(session.current)) { say(session.current.cue, true); refresh(); } };
  const selectAnswer = (choice: number) => { const s = session.current; if (screenRef.current === 'session' && s.activity === 'trivia' && !s.answered && !pausedRef.current) { s.choice = choice; refresh(); } };
  callbacks.current.onCommand = (text: string) => {
    const command = parseVoiceCommand(text); setVoiceMessage(`Heard: “${text}”${command ? '' : '. Try squats, pause, resume, finish, home, left, right, or confirm.'}`);
    if (!command) return;
    if (command === 'home') home();
    else if (command === 'start') { if (screenRef.current === 'setup') begin(); }
    else if (command === 'repeat') say(instructions[session.current.activity], true);
    else if (command === 'pause' || command === 'resume') { if (screenRef.current === 'session') pause(command === 'pause'); }
    else if (command === 'finish') { if (screenRef.current === 'session') finish(); }
    else if (command === 'left' || command === 'right') selectAnswer(command === 'left' ? 0 : 1);
    else if (command === 'confirm') confirm();
    else choose(command);
  };
  callbacks.current.onHands = hands => {
    if (screenRef.current !== 'session' || !foreground.current || listening.current || cameraRef.current !== 'CONNECTED') return;
    const now = Date.now(); const hand = hands.filter(h => h.score >= 0.65).sort((a, b) => b.score - a.score)[0];
    if (!hand) { if (now - gesture.current.seen > 2500) gesture.current = { name: '', at: 0, seen: 0, fired: false, samples: 0 }; handStart.current = null; return; }
    const origin = handStart.current;
    if (!origin || now - origin.at > 2500) handStart.current = { x: hand.x, at: now };
    else if (Math.abs(hand.x - origin.x) > 0.23 && now - lastSwipe.current > 1200) { lastSwipe.current = now; handStart.current = null; selectAnswer(hand.x > origin.x ? 1 : 0); setGestureMessage('Swipe selected an answer. Point up to confirm.'); }
    if (gesture.current.name !== hand.gesture || now - gesture.current.seen > 700) gesture.current = { name: hand.gesture, at: now, seen: now, fired: false, samples: 1 };
    else { gesture.current.seen = now; gesture.current.samples++; }
    const candidate = gesture.current;
    if (candidate.fired || candidate.samples < 3 || now - candidate.at < 650) return;
    candidate.fired = true;
    // Palms and fists are common exercise poses, so they must not toggle pause.
    if (hand.gesture === 'Victory') { pause(!pausedRef.current); setGestureMessage('Victory sign: pause / resume. Lower your hand before repeating.'); }
    else if (hand.gesture === 'Pointing_Up') confirm();
    else if (hand.gesture === 'Thumb_Up') setGestureMessage('Thumbs up! Keep going.');
    else if (hand.gesture === 'Thumb_Down') { pause(true); setGestureMessage('Paused. Take a rest, then resume when ready.'); }
    else if (hand.gesture === 'ILoveYou') setGestureMessage('Bonus cheer! Great energy.');
  };

  useEffect(() => {
    const cameraEvents = MotionCamera ? new NativeEventEmitter(MotionCamera) : null;
    const voiceEvents = CoachVoice ? new NativeEventEmitter(CoachVoice) : null;
    let mounted = true;
    void MotionCamera?.savedStreamUrl().then((url: string) => { if (mounted && !urlRef.current) { urlRef.current = url; setStreamUrl(url); } });
    const capabilities = () => { void CoachVoice?.capabilities().then((value: { speech: boolean; engine: string; recognition: boolean; onDevice: boolean }) => {
      if (!mounted) return; setVoiceAvailable(value.recognition);
      const output = value.speech ? (value.engine === 'BUNDLED' ? 'Bundled spoken coach ready.' : 'TV spoken coach ready.') : 'Spoken coach is unavailable in this build.';
      setVoiceMessage(`${output} ${value.recognition ? (value.onDevice ? 'Select VOICE COMMAND for on-device recognition.' : 'TV speech recognition may use a network service.') : 'For commands, tap SPEAK TV COMMAND in the updated phone companion.'}`);
    }); };
    capabilities();
    const statusSub = cameraEvents?.addListener('MotionPlayStatus', (event: { state: string; message: string }) => {
      cameraRef.current = event.state; setCameraState(event.state); setCameraMessage(event.message);
      if (event.state !== 'CONNECTED') { lastFrame.current = 0; setPreview(''); setOverlay([]); suspendTracking(session.current); }
    });
    const frameSub = cameraEvents?.addListener('MotionPlayFrame', (frame: Frame) => {
      if (cameraRef.current !== 'CONNECTED' || !foreground.current) return;
      const now = Date.now(); lastFrame.current = now; setRotation(frame.rotationDegrees ?? 0); setOrientationReady(frame.orientationLocked !== false); setInferenceMs(frame.inferenceMs ?? 0); const imageAspect = frame.imageWidth && frame.imageHeight ? frame.imageWidth / frame.imageHeight : 4 / 3;
      setAspect(imageAspect); setOverlay(frame.poses ?? []); if (frame.preview) setPreview(frame.preview);
      if (frame.orientationLocked !== false && screenRef.current === 'session' && !pausedRef.current && !listening.current && !session.current.done) {
        const before = session.current.reps, points = session.current.points; updatePoses(session.current, frame.poses ?? [], now, imageAspect);
        if (session.current.reps > before) say(`Rep ${session.current.reps}.`, true);
        else if (session.current.points > points) say(session.current.cue, true);
        else if (workouts.includes(session.current.activity)) say(session.current.cue);
      }
      if (frame.gesturesUpdated !== false) callbacks.current.onHands(frame.gestures ?? []); refresh();
    });
    const voiceSub = voiceEvents?.addListener('CoachVoiceEvent', (event: { state: string; message: string }) => {
      if (event.state === 'VOICE_READY' || event.state === 'VOICE_UNAVAILABLE') { capabilities(); return; }
      listening.current = event.state === 'LISTENING' || event.state === 'PROCESSING';
      if (event.state === 'RESULT') callbacks.current.onCommand(event.message); else setVoiceMessage(event.message);
    });
    const commandSub = cameraEvents?.addListener('MotionPlayCommand', (event: { text: string }) => {
      if (foreground.current && cameraRef.current === 'CONNECTED') callbacks.current.onCommand(event.text);
    });
    let lastTick = Date.now(), lastPrompt = '';
    const timer = setInterval(() => {
      const now = Date.now(), dt = now - lastTick; lastTick = now;
      if (screenRef.current !== 'session' || pausedRef.current || listening.current || !foreground.current) return;
      const s = session.current;
      const fresh = sessionClockRunning(cameraRef.current === 'CONNECTED', lastFrame.current > 0);
      if (!fresh && s.activity !== 'trivia') { suspendTracking(s); refresh(); return; }
      const oldPoints = s.points; tickSession(s, dt);
      const prompt = s.activity === 'freeze' ? freezePhase(s.elapsed) : s.activity === 'mimic' ? (s.target === 0 ? 'Stretch both arms sideways at shoulder height.' : 'Reach both hands overhead.') : s.activity === 'trivia' && !s.answered && questions[s.question] ? `${questions[s.question].text} Left: ${questions[s.question].options[0]}. Right: ${questions[s.question].options[1]}.` : '';
      if (prompt && prompt !== lastPrompt) { lastPrompt = prompt; say(prompt, true); }
      if (s.points > oldPoints) say(`Round complete. ${s.points} points.`, true);
      if (s.done) finish(); refresh();
    }, 250);
    const back = BackHandler.addEventListener('hardwareBackPress', () => { if (screenRef.current === 'home') return false; if (screenRef.current === 'session') finish(); else home(); return true; });
    const appState = AppState.addEventListener('change', state => { foreground.current = state === 'active'; if (state !== 'active') { pausedRef.current = true; setPaused(true); suspendTracking(session.current); CoachVoice?.silence(); CoachVoice?.stopListening(); listening.current = false; } });
    return () => { mounted = false; clearInterval(timer); statusSub?.remove(); frameSub?.remove(); voiceSub?.remove(); commandSub?.remove(); back.remove(); appState.remove(); CoachVoice?.silence(); CoachVoice?.stopListening(); void MotionCamera?.stopStream(); };
  }, []);
  const listen = async () => {
    if (!voiceAvailable) { setVoiceMessage('Use SPEAK TV COMMAND in the updated phone companion while its camera stream is connected. The TV remote microphone is not exposed to this app.'); return; }
    try {
      const permission = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
      if (permission !== PermissionsAndroid.RESULTS.GRANTED) { setVoiceMessage('Microphone permission denied. Remote controls remain available.'); return; }
      suspendTracking(session.current);
      CoachVoice?.silence(); listening.current = true; setVoiceMessage('Starting microphone…'); await CoachVoice.listen();
    } catch (error) { listening.current = false; setVoiceMessage(String(error)); }
  };
  const s = session.current, activePlayers = s.players.filter(p => Date.now() - p.seen < TRACKING_TIMEOUT_MS);
  const waiting = cameraState !== 'CONNECTED' || Date.now() - lastFrame.current >= TRACKING_TIMEOUT_MS || !activePlayers.some(p => p.visible);
  const waitingMessage = cameraState !== 'CONNECTED' ? 'Connect the phone camera. Session time is waiting.' : 'Keep hips, knees and feet in view. Use ROTATE CAMERA if the picture is sideways. The timer is running.';
  const game = games.includes(s.activity), question = questions[Math.min(s.question, questions.length - 1)];
  const prompt = !orientationReady && cameraState === 'CONNECTED' ? 'FINDING UPRIGHT CAMERA VIEW' : paused ? 'PAUSED' : waiting && s.activity !== 'trivia' ? 'POSITION YOURSELF IN VIEW' : s.activity === 'freeze' ? freezePhase(s.elapsed) : s.activity === 'mimic' ? (s.target === 0 ? 'T POSE · ARMS SIDEWAYS' : 'BOTH HANDS OVERHEAD') : s.activity === 'trivia' ? `QUESTION ${Math.min(s.question + 1, questions.length)} / ${questions.length}` : activePlayers.some(p => !p.good) ? 'ADJUST YOUR MOVEMENT' : 'FOLLOW THE COACH';
  const rotateCamera = () => { void MotionCamera?.setCameraRotation((rotation + 90) % 360); suspendTracking(s); setOverlay([]); setPreview(''); };
  const rotateButton = <Action title='ROTATE CAMERA' hint={`${rotation} degrees · select until upright`} onPress={rotateCamera} />;
  const voiceBar = <View style={styles.voiceBar}><Action title={voiceEnabled ? 'COACH VOICE: ON' : 'COACH VOICE: OFF'} onPress={() => { voiceEnabledRef.current = !voiceEnabledRef.current; setVoiceEnabled(voiceEnabledRef.current); if (!voiceEnabledRef.current) CoachVoice?.silence(); }} /><Action title="TEST COACH VOICE" onPress={() => say('Voice test. Your MoveQuest coach is ready.', true)} /><Action title={voiceAvailable ? 'VOICE COMMAND' : 'PHONE VOICE COMMAND'} hint={voiceAvailable ? 'Select, then speak one command' : 'Check TV speech support'} onPress={() => void listen()} /><Text accessibilityLiveRegion="polite" style={styles.voiceStatus}>{voiceMessage}</Text></View>;
  const cameraCard = <View style={styles.cameraCard}><View style={styles.cameraCopy}><Text style={styles.cardTitle}>CONNECT YOUR PHONE CAMERA</Text><Text style={styles.cardSub}>Start the phone stream. Keep phone and TV on the same Wi-Fi.</Text><Text accessibilityLiveRegion="polite" style={styles.cameraStatus}>{cameraMessage}</Text></View><TextInput accessibilityLabel="Phone camera stream URL" value={streamUrl} onChangeText={value => { urlRef.current = value; setStreamUrl(value); }} placeholder="http://192.168.0.144:8080/video" placeholderTextColor="#788071" autoCapitalize="none" autoCorrect={false} style={styles.input} /><Action title={cameraState === 'CONNECTED' ? 'DISCONNECT' : 'CONNECT CAMERA'} primary onPress={() => { if (cameraState === 'CONNECTED') void MotionCamera?.stopStream(); else void connect(); }} /></View>;
  return <View style={styles.root}><StatusBar hidden /><View style={styles.topbar}><Image accessible={false} source={require('./assets/motionplay-icon.png')} style={{ width: 30, height: 30, borderRadius: 8 }} /><Text style={styles.brand}>Move<Text style={{ color: '#B9F46A' }}>Quest</Text></Text><Text style={styles.tag}>AI POSE COACH · CAMERA STAYS LOCAL</Text><Text accessibilityLiveRegion="polite" style={styles.liveText}>{cameraState}</Text></View>
    {screen === 'home' && <ScrollView contentContainerStyle={styles.page}><Text style={styles.heroTitle}>Move with your AI coach.</Text><Text style={styles.heroDesc}>Choose an activity for instructions, pose feedback and complete-rep counting. Camera estimates are guidance, not a medical assessment.</Text>{cameraCard}<View style={styles.voiceBar}>{rotateButton}<Action title='AUTO ORIENTATION' onPress={() => { void MotionCamera?.setCameraRotation(-1); suspendTracking(s); }} /></View>{voiceBar}<Text style={styles.sectionTitle}>Workouts</Text><View style={styles.cards}>{workouts.map((activity, index) => <Card key={activity} activity={activity} index={index} onPress={() => choose(activity)} />)}</View><Text style={[styles.sectionTitle, { marginTop: 18 }]}>Family games</Text><View style={styles.cards}>{games.map((activity, index) => <Card key={activity} activity={activity} index={index} onPress={() => choose(activity)} />)}</View><Text style={styles.coachNote}>Camera video is processed on this TV. Use a clear space, move comfortably, and stop if you feel pain. Select VOICE COMMAND before speaking.</Text></ScrollView>}
    {screen === 'setup' && <ScrollView contentContainerStyle={styles.page}><Text style={styles.eyebrow}>BEFORE YOU START</Text><Text style={styles.heroTitle}>{activityTitles[s.activity]}</Text><Text style={styles.setupInstructions}>{instructions[s.activity]}</Text><Text style={styles.coachNote}>Secure the phone to show your entire body in bright lighting. For squats, turn slightly sideways. Counts require clear joints and a complete movement; form feedback is a 2D estimate.</Text>{cameraCard}{voiceBar}<View style={styles.voiceBar}><Action title="START SESSION" hint={s.activity === 'trivia' ? 'Camera gestures or remote answers' : 'Timer starts with the camera feed'} primary onPress={begin} /><Action title="REPEAT INSTRUCTIONS" onPress={() => say(instructions[s.activity], true)} /><Action title="BACK TO HOME" onPress={home} /></View></ScrollView>}
    {screen === 'session' && <View style={styles.session}><View style={styles.sessionTop}><Text style={styles.sessionTitle}>{activityTitles[s.activity]}</Text><Text style={styles.timer}>{paused ? 'PAUSED' : `${String(Math.floor(Math.ceil((s.duration - s.elapsed) / 1000) / 60)).padStart(2, '0')}:${String(Math.ceil((s.duration - s.elapsed) / 1000) % 60).padStart(2, '0')}`}</Text></View><View style={styles.stage}>{preview ? <Image source={{ uri: `data:image/jpeg;base64,${preview}` }} resizeMode="contain" style={styles.preview} /> : <Text style={styles.instruction}>Keep your phone stream open and your whole body in view.</Text>}{!waiting && <PoseOverlay poses={overlay} aspect={aspect} good={activePlayers.every(p => p.good)} />}<View style={styles.stageOverlay}><Text style={styles.prompt}>{prompt}</Text><Text accessibilityLiveRegion="polite" style={styles.instruction}>{paused ? 'Select RESUME when ready. Reps and game scores are paused.' : s.activity === 'trivia' ? question.text : waiting ? waitingMessage : s.cue}</Text>{s.activity === 'trivia' && <View style={styles.answerRow}>{question.options.map((answer, index) => <Action key={answer} title={`${index === 0 ? 'LEFT' : 'RIGHT'}: ${answer}`} primary={s.choice === index} onPress={() => selectAnswer(index)} />)}<Action title="CONFIRM" onPress={confirm} />{s.answered && <Text style={styles.feedback}>{s.cue}</Text>}</View>}</View><View style={styles.playerBadge}><Text style={styles.playerNumber}>{activePlayers.length}</Text><Text style={styles.metricLabel}>IN VIEW</Text></View></View><View style={styles.playerRow}>{activePlayers.map(p => <Text key={p.id} style={[styles.playerFeedback, { color: p.good ? '#B9F46A' : '#FFB86B' }]}>P{p.id}: {game ? p.cue : `${p.reps} reps · ${p.cue}`}</Text>)}</View><View style={styles.metrics}><View><Text style={styles.metricValue}>{game ? s.points : s.reps}</Text><Text style={styles.metricLabel}>{game ? 'GAME POINTS' : 'COMPLETE GROUP REPS'}</Text></View><View style={{ flex: 1 }}><View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${s.elapsed / s.duration * 100}%` }]} /></View><Text style={styles.feedback}>{gestureMessage || 'Hold Victory to pause/resume. Thumbs down to rest. Remote controls always work.'}</Text></View><Action title={paused ? 'RESUME' : 'PAUSE'} onPress={() => pause(!pausedRef.current)} />{rotateButton}<Action title="FINISH" onPress={finish} /></View><Text accessibilityLiveRegion="polite" style={styles.feedback}>{`Tracking: ${Math.round(inferenceMs)} ms per frame · ${voiceMessage}`}</Text></View>}
    {screen === 'results' && <ScrollView contentContainerStyle={styles.resultPage}><Text style={styles.eyebrow}>SESSION COMPLETE</Text><Text style={styles.resultsTitle}>{activityTitles[s.activity]}</Text><Text style={styles.resultsSub}>{Math.floor(s.elapsed / 1000)} seconds of active session time.</Text><View style={styles.resultStats}><Text style={styles.metricValue}>{game ? s.points : s.reps}</Text><Text style={styles.metricLabel}>{game ? 'GAME POINTS' : 'COMPLETE REPS'}</Text></View><Text style={styles.setupInstructions}>{s.activity === 'trivia' ? `${s.correct} correct answers out of ${questions.length}.` : game ? 'Points come from observed movement and completed game rules.' : `${s.rejected} cycles were not counted because form or timing checks were not met.`}</Text><Text style={styles.coachNote}>Pose estimates can miss movements or misread form. Counts are for gameplay and general feedback.</Text><View style={styles.voiceBar}><Action title="PLAY AGAIN" primary onPress={() => choose(s.activity)} /><Action title="BACK TO HOME" onPress={home} /></View></ScrollView>}
  </View>;
}

function PoseOverlay({ poses, aspect, good }: { poses: Landmark[][]; aspect: number; good: boolean }) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const width = Math.min(size.width, size.height * aspect), height = width / aspect;
  const left = (size.width - width) / 2, top = (size.height - height) / 2;
  const links = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28]];
  return <View pointerEvents="none" style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }} onLayout={event => setSize(event.nativeEvent.layout)}>{poses.slice(0, 4).flatMap((pose, person) => links.map(([a, b], index) => {
    const p = pose[a], q = pose[b]; if (!p || !q || (p.visibility ?? 0) < 0.6 || (q.visibility ?? 0) < 0.6) return null;
    const x1 = left + p.x * width, y1 = top + p.y * height, x2 = left + q.x * width, y2 = top + q.y * height, length = Math.hypot(x2 - x1, y2 - y1);
    return <View key={`${person}-${index}`} style={{ position: 'absolute', left: (x1 + x2) / 2 - length / 2, top: (y1 + y2) / 2, width: length, height: 2, backgroundColor: good ? '#B9F46A' : '#FFB86B', transform: [{ rotate: `${Math.atan2(y2 - y1, x2 - x1)}rad` }] }} />;
  }))}</View>;
}
