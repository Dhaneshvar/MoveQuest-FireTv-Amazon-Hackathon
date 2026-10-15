export type Landmark = {
  x: number;
  y: number;
  z?: number;
  visibility?: number;
};

export type PoseEvent =
  | { type: 'REP_COMPLETED'; exercise: 'squat'; count: number; form: number }
  | { type: 'PLAYER_UPDATE'; players: Array<{ playerId: string; reps: number; exercise: ExerciseId; movement: 'moving' | 'still' }> }
  | { type: 'POSE_STATUS'; visible: boolean }
  | { type: 'GAME_ACTION'; action: 'PAUSE' | 'RESUME' | 'SKIP' | 'THUMBS_UP' | 'THUMBS_DOWN'; playerId: string };

export type ExerciseId = 'squat' | 'jumping-jacks' | 'arm-raises';
export type RepPhase = 'ready' | 'active';

function point(landmarks: Landmark[], index: number): Landmark | null {
  const value = landmarks[index];
  return value && Number.isFinite(value.x) && Number.isFinite(value.y) && (value.visibility ?? 1) >= 0.5 ? value : null;
}

function distance(a: Landmark, b: Landmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function bothArmsRaised(landmarks: Landmark[]): boolean {
  const leftShoulder = point(landmarks, 11);
  const rightShoulder = point(landmarks, 12);
  const leftWrist = point(landmarks, 15);
  const rightWrist = point(landmarks, 16);
  return !!leftShoulder && !!rightShoulder && !!leftWrist && !!rightWrist &&
    leftWrist.y < leftShoulder.y - 0.08 && rightWrist.y < rightShoulder.y - 0.08;
}

export function poseCenterX(landmarks: Landmark[]): number | null {
  const torso = [11, 12, 23, 24].map(index => point(landmarks, index)).filter((p): p is Landmark => p !== null);
  if (torso.length < 2) return null;
  return torso.reduce((sum, p) => sum + p.x, 0) / torso.length;
}

export function exerciseCue(exercise: ExerciseId, landmarks: Landmark[]): string {
  if (exercise === 'squat') {
    const angle = squatKneeAngle(landmarks);
    if (angle === null) return 'Step back so your hips, knees and ankles are visible';
    return angle < 105 ? 'Nice depth — stand tall to finish the rep' : 'Bend your knees, then rise with control';
  }
  const leftShoulder = point(landmarks, 11);
  const rightShoulder = point(landmarks, 12);
  const leftWrist = point(landmarks, 15);
  const rightWrist = point(landmarks, 16);
  if (!leftShoulder || !rightShoulder || !leftWrist || !rightWrist) return 'Face the phone and keep your upper body in view';
  return bothArmsRaised(landmarks) ? 'Great — lower your arms to complete the rep' : 'Raise both arms above your shoulders';
}

export function exerciseRepStep(exercise: ExerciseId, landmarks: Landmark[], phase: RepPhase): { phase: RepPhase; rep: boolean } {
  if (exercise === 'squat') {
    const angle = squatKneeAngle(landmarks);
    if (angle === null) return { phase: 'ready', rep: false };
    if (phase === 'active') {
      if (angle >= 160) return { phase: 'ready', rep: true };
      return { phase: 'active', rep: false };
    }
    return { phase: angle <= 115 ? 'active' : 'ready', rep: false };
  }

  const leftShoulder = point(landmarks, 11);
  const rightShoulder = point(landmarks, 12);
  const armsRaised = bothArmsRaised(landmarks);

  if (exercise === 'arm-raises') {
    if (phase === 'active' && !armsRaised) return { phase: 'ready', rep: true };
    return { phase: armsRaised ? 'active' : 'ready', rep: false };
  }

  const leftAnkle = point(landmarks, 27);
  const rightAnkle = point(landmarks, 28);
  const shouldersApart = !!leftShoulder && !!rightShoulder && distance(leftShoulder, rightShoulder) > 0.02;
  const feetApart = shouldersApart && !!leftAnkle && !!rightAnkle && distance(leftAnkle, rightAnkle) > distance(leftShoulder!, rightShoulder!) * 1.35;
  const open = armsRaised && shouldersApart && feetApart;
  if (phase === 'active' && !open) return { phase: 'ready', rep: true };
  return { phase: open ? 'active' : 'ready', rep: false };
}

export function poseMotion(previous: Landmark[], current: Landmark[]): number {
  const usable = [11, 12, 15, 16, 23, 24, 25, 26, 27, 28]
    .map(index => [point(previous, index), point(current, index)] as const)
    .filter((pair): pair is readonly [Landmark, Landmark] => !!pair[0] && !!pair[1]);
  if (usable.length < 4) return 0;
  return usable.reduce((sum, [before, after]) => sum + distance(before, after), 0) / usable.length;
}

export function angleAt(a: Landmark, b: Landmark, c: Landmark): number {
  const ab = { x: a.x - b.x, y: a.y - b.y };
  const cb = { x: c.x - b.x, y: c.y - b.y };
  const dot = ab.x * cb.x + ab.y * cb.y;
  const denom = Math.hypot(ab.x, ab.y) * Math.hypot(cb.x, cb.y);
  if (!denom) return 180;
  return (Math.acos(Math.max(-1, Math.min(1, dot / denom))) * 180) / Math.PI;
}

export function squatKneeAngle(landmarks: Landmark[]): number | null {
  const left = [landmarks[23], landmarks[25], landmarks[27]];
  const right = [landmarks[24], landmarks[26], landmarks[28]];
  const usable = [left, right].filter(side => {
    if (!side.every(point => point && Number.isFinite(point.x) && Number.isFinite(point.y) && (point.visibility ?? 1) >= 0.55)) return false;
    const [hip, knee, ankle] = side as [Landmark, Landmark, Landmark];
    const hipToKnee = distance(hip, knee);
    const kneeToAnkle = distance(knee, ankle);
    // Reject collapsed or anatomically inverted leg landmarks (often caused by a partial/occluded pose).
    return hip.y < knee.y && knee.y < ankle.y && hipToKnee >= 0.035 && kneeToAnkle >= 0.035;
  });
  if (!usable.length) return null;
  const angles = usable.map(([hip, knee, ankle]) => angleAt(hip!, knee!, ankle!));
  return angles.reduce((total, current) => total + current, 0) / angles.length;
}

export function squatRepState(angle: number, previous: 'standing' | 'lowering' | 'down'): 'standing' | 'lowering' | 'down' | 'rep' {
  if (angle < 105) return 'down';
  if (previous === 'down') return angle > 155 ? 'rep' : 'down';
  if (angle < 155) return 'lowering';
  return 'standing';
}
