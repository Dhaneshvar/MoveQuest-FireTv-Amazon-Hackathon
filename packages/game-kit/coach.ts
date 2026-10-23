import { angleAt, poseCenterX, poseMotion, type ExerciseId, type Landmark } from './index';

export type Assessment = { visible: boolean; position: 'rest' | 'active' | 'between'; good: boolean; cue: string };
export const TRACKING_TIMEOUT_MS = 6000;
export function sessionClockRunning(connected: boolean, hasFrame: boolean): boolean { return connected && hasFrame; }
export type Cycle = { armed: boolean; restAt: number; activeAt: number; activeSamples: number; bad: boolean; lastRepAt: number };
export const newCycle = (): Cycle => ({ armed: false, restAt: 0, activeAt: 0, activeSamples: 0, bad: false, lastRepAt: -10000 });
const usable = (p: Landmark | undefined): p is Landmark => !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && (p.visibility ?? 1) >= 0.45;

// Coordinates must be in image aspect ratio (x scaled by image width / height).
export function assessExercise(exercise: ExerciseId, points: Landmark[]): Assessment {
  const missing = (cue: string): Assessment => ({ visible: false, position: 'between', good: false, cue });
  const p = points;
  if (exercise === 'squat') {
    const sides = [[11, 23, 25, 27], [12, 24, 26, 28]].filter(side => side.every(i => usable(p[i])));
    if (!sides.length) return missing('Step back until at least one shoulder, hip, knee and ankle are visible.');
    const torso = Math.max(...sides.map(([shoulder, hip]) => Math.hypot(p[shoulder].x - p[hip].x, p[shoulder].y - p[hip].y)));
    if (torso < 0.06) return missing('Move closer so your body is clear.');
    if (sides.some(([, hip, knee, ankle]) => Math.hypot(p[hip].x - p[knee].x, p[hip].y - p[knee].y) < torso * 0.2 || Math.hypot(p[knee].x - p[ankle].x, p[knee].y - p[ankle].y) < torso * 0.2)) return missing('Show both legs clearly; the knee landmarks are overlapping.');
    const angles = sides.map(([, hip, knee, ankle]) => angleAt(p[hip], p[knee], p[ankle]));
    if (sides.some(([, hip, knee, ankle]) => p[hip].y > p[knee].y + torso * 0.4 || p[knee].y >= p[ankle].y)) return missing('Keep your whole body visible and turn slightly sideways.');
    const knee = angles.reduce((sum, angle) => sum + angle, 0) / angles.length;
    const lean = Math.max(...sides.map(([shoulder, hip]) => Math.atan2(Math.abs(p[shoulder].x - p[hip].x), p[hip].y - p[shoulder].y) * 180 / Math.PI));
    const good = lean < 65 && (angles.length < 2 || Math.abs(angles[0] - angles[1]) < 45);
    return { visible: true, position: knee >= 155 ? 'rest' : knee <= 125 ? 'active' : 'between', good,
      cue: lean >= 55 ? 'Lift your chest and reduce the forward lean.' : !good ? 'Bend both knees evenly, with control.' : knee <= 115 ? 'Good depth. Push up gently and stand tall.' : knee >= 160 ? 'Stand tall, then bend your hips and knees with control.' : 'Lower only as far as comfortable, then stand tall.' };
  }
  const indices = exercise === 'arm-raises' ? [11, 12, 13, 14, 15, 16, 23, 24] : [11, 12, 23, 24, 25, 26, 27, 28, 15, 16];
  if (!indices.every(i => usable(p[i]))) return missing('Step back and keep the required joints in view.');
  const torso = (Math.hypot(p[11].x - p[23].x, p[11].y - p[23].y) + Math.hypot(p[12].x - p[24].x, p[12].y - p[24].y)) / 2;
  if (torso < 0.06) return missing('Move closer so your body is clear.');
  const raised = p[15].y < p[11].y - torso * 0.5 && p[16].y < p[12].y - torso * 0.5;
  const lowered = p[15].y > p[11].y + torso * 0.5 && p[16].y > p[12].y + torso * 0.5;
  const symmetric = Math.abs((p[15].y - p[11].y) - (p[16].y - p[12].y)) < torso * 0.5;
  if (exercise === 'arm-raises') {
    const elbows = [angleAt(p[11], p[13], p[15]), angleAt(p[12], p[14], p[16])];
    const good = symmetric && (!raised || Math.min(...elbows) >= 145);
    return { visible: true, position: raised ? 'active' : lowered ? 'rest' : 'between', good,
      cue: !symmetric ? 'Raise both arms evenly.' : !good ? 'Keep a gentle, straighter reach through both elbows.' : raised ? 'Good reach. Lower both hands beside your hips.' : 'Raise both arms overhead, then lower them fully.' };
  }
  const shoulderWidth = Math.abs(p[11].x - p[12].x);
  if (shoulderWidth < torso * 0.25) return missing('Face the camera for jumping jacks.');
  const feet = Math.abs(p[27].x - p[28].x) / shoulderWidth;
  return { visible: true, position: raised && feet >= 1.45 ? 'active' : lowered && feet <= 1.15 ? 'rest' : 'between', good: symmetric,
    cue: !symmetric ? 'Move both arms together.' : raised && feet < 1.45 ? 'Open your feet as you raise your arms.' : feet >= 1.45 && !raised ? 'Raise both hands overhead with your feet apart.' : raised ? 'Good opening. Bring feet together and hands down.' : 'Start with feet together and hands down. Open, then close.' };
}

export function advanceCycle(old: Cycle, pose: Assessment, now: number): { cycle: Cycle; rep: boolean; rejected: boolean } {
  let cycle = { ...old };
  if (!pose.visible) return { cycle: newCycle(), rep: false, rejected: false };
  if (pose.position === 'rest') {
    const completed = cycle.armed && cycle.activeSamples >= 1 && now - cycle.activeAt >= 150 && now - cycle.restAt >= 600 && now - cycle.activeAt <= 20000;
    const rep = completed && !cycle.bad && pose.good && now - cycle.lastRepAt >= 600;
    const rejected = completed && !rep;
    cycle = { ...newCycle(), armed: true, restAt: now, lastRepAt: rep ? now : cycle.lastRepAt };
    return { cycle, rep, rejected };
  }
  if (cycle.armed && !pose.good) cycle.bad = true;
  if (cycle.armed && pose.position === 'active') {
    if (!cycle.activeSamples) cycle.activeAt = now;
    cycle.activeSamples++;
  }
  return { cycle, rep: false, rejected: false };
}

export type Activity = ExerciseId | 'freeze' | 'mimic' | 'trivia';
export const activityTitles: Record<Activity, string> = { squat: 'Squat challenge', 'jumping-jacks': 'Jumping jacks', 'arm-raises': 'Arm raises', freeze: 'Freeze Dance', mimic: 'Mimic the Pose', trivia: 'Gesture Trivia' };
export const instructions: Record<Activity, string> = {
  squat: 'Turn slightly sideways. Stand tall, lower with control, hold briefly, then stand again. Only complete, clear repetitions count.',
  'jumping-jacks': 'Face the camera. Start with feet together and arms down. Open your feet and raise both hands, then close.',
  'arm-raises': 'Face the camera. Start with hands beside your hips. Reach both arms overhead, then lower them fully.',
  freeze: 'Move during MOVE. Hold still during FREEZE. Earn one point per tracked player for each successful round.',
  mimic: 'Copy the target pose. Hold it for two seconds to earn a point. The target alternates after each success.',
  trivia: 'Choose the left or right answer. Swipe to choose, then hold a pointing-up gesture to confirm. Remote buttons also work.',
};
export const questions = [
  { text: 'Which activity starts with feet together, then opens arms and legs?', options: ['Jumping jacks', 'Squats'], answer: 0 },
  { text: 'When the coach says FREEZE, what should you do?', options: ['Keep dancing', 'Hold still'], answer: 1 },
  { text: 'For camera tracking, what needs to be visible?', options: ['Your whole body', 'Only your face'], answer: 0 },
  { text: 'To finish an arm raise, where do your hands return?', options: ['Stay overhead', 'Beside your hips'], answer: 1 },
  { text: 'Which action completes a squat repetition?', options: ['Stand tall again', 'Stay lowered'], answer: 0 },
];
export type TrackedPlayer = { id: number; center: number; seen: number; pose: Landmark[]; previous: Landmark[]; cycle: Cycle; reps: number; cue: string; visible: boolean; good: boolean; moving: boolean; roundMoving: boolean; freezeBroken: boolean; hold: number; holding: boolean };
export type SessionState = { activity: Activity; elapsed: number; duration: number; reps: number; points: number; rejected: number; players: TrackedPlayer[]; nextId: number; cue: string; round: number; target: number; question: number; choice: number; answered: boolean; answerAt: number; correct: number; done: boolean };
export function createSession(activity: Activity): SessionState {
  return { activity, elapsed: 0, duration: activity === 'trivia' ? 90000 : 45000, reps: 0, points: 0, rejected: 0, players: [], nextId: 1, cue: instructions[activity], round: 0, target: 0, question: 0, choice: 0, answered: false, answerAt: 0, correct: 0, done: false };
}
export function suspendTracking(state: SessionState): void {
  for (const player of state.players) { player.cycle = newCycle(); player.hold = 0; player.holding = false; player.previous = []; player.roundMoving = false; player.freezeBroken = true; }
}
export function freezePhase(elapsed: number): 'MOVE' | 'FREEZE' { return elapsed % 10000 < 6000 ? 'MOVE' : 'FREEZE'; }
export function tickSession(state: SessionState, dt: number): void {
  if (state.done) return;
  const oldRound = Math.floor(state.elapsed / 10000);
  state.elapsed = Math.min(state.duration, state.elapsed + Math.max(0, Math.min(dt, 500)));
  if (state.activity === 'freeze' && Math.floor(state.elapsed / 10000) > oldRound) {
    state.points += state.players.filter(p => p.roundMoving && !p.freezeBroken).length;
    for (const p of state.players) { p.roundMoving = false; p.freezeBroken = false; }
  }
  if (state.activity === 'trivia' && state.answered && state.elapsed - state.answerAt >= 1800) {
    state.question++;
    state.answered = false;
    state.choice = 0;
    if (state.question >= questions.length) state.done = true;
  }
  if (state.elapsed >= state.duration) state.done = true;
}
export function answerTrivia(state: SessionState): boolean {
  if (state.activity !== 'trivia' || state.answered || state.done) return false;
  const correct = state.choice === questions[state.question].answer;
  state.answered = true; state.answerAt = state.elapsed;
  if (correct) { state.correct++; state.points += 10; }
  state.cue = correct ? 'Correct! Great answer.' : `The answer is ${questions[state.question].options[questions[state.question].answer]}.`;
  return true;
}
export function updatePoses(state: SessionState, poses: Landmark[][], now: number, aspect = 1): void {
  if (state.done) return;
  const used = new Set<number>();
  const scoredPoses = poses.slice(0, 4).map(pose => pose.map(p => ({ ...p, x: p.x * aspect })));
  for (const pose of scoredPoses) {
    const center = poseCenterX(pose);
    if (center === null) continue;
    let player = state.players.filter(p => !used.has(p.id) && now - p.seen < TRACKING_TIMEOUT_MS && Math.abs(p.center - center) < aspect * 0.25).sort((a, b) => Math.abs(a.center - center) - Math.abs(b.center - center))[0];
    if (!player) {
      player = { id: state.nextId++, center, seen: now, pose, previous: [], cycle: newCycle(), reps: 0, cue: '', visible: false, good: false, moving: false, roundMoving: false, freezeBroken: freezePhase(state.elapsed) === 'FREEZE', hold: 0, holding: false };
      state.players.push(player);
    }
    used.add(player.id);
    const gap = now - player.seen;
    if (gap > TRACKING_TIMEOUT_MS) { player.cycle = newCycle(); player.previous = []; player.hold = 0; player.holding = false; player.freezeBroken = true; }
    const dt = player.previous.length ? Math.max(0, Math.min(gap, 500)) : 0;
    player.moving = player.previous.length > 0 && poseMotion(player.previous, pose) > 0.018;
    player.center = center; player.seen = now; player.pose = pose;
    if (state.activity === 'squat' || state.activity === 'jumping-jacks' || state.activity === 'arm-raises') {
      const assessment = assessExercise(state.activity, pose);
      const result = advanceCycle(player.cycle, assessment, now);
      player.cycle = result.cycle; player.cue = assessment.cue; player.visible = assessment.visible; player.good = assessment.visible && assessment.good;
      if (result.rep) { player.reps++; state.reps++; state.cue = `Rep ${state.reps}. Good complete movement.`; }
      else if (result.rejected) { state.rejected++; state.cue = 'Reset at the starting position. Follow the form cue and try again.'; }
      else if (player.id === state.players.filter(p => used.has(p.id))[0]?.id) state.cue = assessment.cue;
    } else if (state.activity === 'freeze') {
      const visible = [11, 12, 15, 16, 23, 24, 27, 28].every(i => usable(pose[i]));
      player.visible = visible;
      if (!visible) player.freezeBroken = true;
      if (freezePhase(state.elapsed) === 'MOVE' && visible && player.moving) player.roundMoving = true;
      if (freezePhase(state.elapsed) === 'FREEZE' && state.elapsed % 10000 >= 6800 && player.moving) player.freezeBroken = true;
      player.good = visible && (freezePhase(state.elapsed) === 'MOVE' || !player.freezeBroken);
      player.cue = !visible ? 'Show your whole body' : freezePhase(state.elapsed) === 'MOVE' ? 'Dance and move!' : player.freezeBroken ? 'Movement detected. Try the next round.' : 'Hold still!';
      state.cue = player.cue;
    } else if (state.activity === 'mimic') {
      const visible = [11, 12, 13, 14, 15, 16, 23, 24].every(i => usable(pose[i]));
      player.visible = visible;
      const torso = visible ? Math.abs(pose[23].y - pose[11].y) : 0;
      const matches = visible && torso > 0.06 && (state.target === 0
        ? Math.abs(pose[15].y - pose[11].y) < torso * 0.25 && Math.abs(pose[16].y - pose[12].y) < torso * 0.25 && Math.abs(pose[15].x - pose[11].x) > torso * 0.5 && Math.abs(pose[16].x - pose[12].x) > torso * 0.5 && (pose[15].x - pose[11].x) * (pose[11].x - pose[12].x) > 0 && (pose[16].x - pose[12].x) * (pose[12].x - pose[11].x) > 0
        : pose[15].y < pose[11].y - torso * 0.65 && pose[16].y < pose[12].y - torso * 0.65);
      player.hold = matches && player.holding ? player.hold + dt : 0; player.holding = matches; player.good = matches;
      player.cue = matches ? `Hold: ${(player.hold / 1000).toFixed(1)} / 2 seconds` : 'Match the target pose and hold it.';
      if (player.hold >= 2000) { state.points++; state.target = 1 - state.target; for (const p of state.players) { p.hold = 0; p.holding = false; } state.cue = 'Pose matched! Copy the next pose.'; }
      else state.cue = player.cue;
    }
    player.previous = pose;
  }
  for (const player of state.players) if (!used.has(player.id)) { player.cycle = newCycle(); player.hold = 0; player.holding = false; player.freezeBroken = true; }
  state.players = state.players.filter(p => now - p.seen < TRACKING_TIMEOUT_MS);
}

export type VoiceCommand = Activity | 'start' | 'pause' | 'resume' | 'finish' | 'home' | 'repeat' | 'left' | 'right' | 'confirm' | null;
export function parseVoiceCommand(text: string): VoiceCommand {
  const clean = text.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (clean === 'start' || clean === 'start session' || clean === 'begin session') return 'start';
  const commands: Record<string, Exclude<VoiceCommand, null>> = { pause: 'pause', 'pause workout': 'pause', resume: 'resume', continue: 'resume', finish: 'finish', stop: 'finish', 'finish workout': 'finish', home: 'home', 'go home': 'home', repeat: 'repeat', 'repeat instructions': 'repeat', left: 'left', right: 'right', confirm: 'confirm', squat: 'squat', squats: 'squat', 'start squats': 'squat', 'jumping jacks': 'jumping-jacks', 'start jumping jacks': 'jumping-jacks', 'arm raises': 'arm-raises', 'start arm raises': 'arm-raises', 'freeze dance': 'freeze', 'start freeze dance': 'freeze', 'mimic the pose': 'mimic', 'mimic pose': 'mimic', 'gesture trivia': 'trivia', 'start gesture trivia': 'trivia' };
  return commands[clean] ?? null;
}
