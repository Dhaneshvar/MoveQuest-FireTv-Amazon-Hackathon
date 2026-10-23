const fs = require('node:fs');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const ts = require('../apps/tv/node_modules/typescript');
require.extensions['.ts'] = (module, path) => module._compile(ts.transpileModule(fs.readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, path);
const { assessExercise, advanceCycle, newCycle, createSession, updatePoses, suspendTracking, tickSession, freezePhase, answerTrivia, questions, parseVoiceCommand, sessionClockRunning } = require('../packages/game-kit/coach.ts');

function pose(position = 'rest') {
  const p = Array.from({ length: 33 }, () => ({ x: .5, y: .5, visibility: 1 }));
  for (const [i, x, y] of [[11,.4,.25],[12,.6,.25],[13,.4,.45],[14,.6,.45],[15,.4,.65],[16,.6,.65],[23,.4,.5],[24,.6,.5],[25,.4,.7],[26,.6,.7],[27,.45,.9],[28,.55,.9]]) p[i] = {x,y,visibility:1};
  if (position === 'raised' || position === 'jack') for (const [i,x,y] of [[13,.4,.15],[14,.6,.15],[15,.4,.02],[16,.6,.02]]) p[i] = {x,y,visibility:1};
  if (position === 'jack') { p[27].x=.2; p[28].x=.8; }
  if (position === 'squat') for (const [i,x,y] of [[11,.28,.25],[12,.48,.25],[23,.28,.5],[24,.48,.5],[25,.5,.65],[26,.7,.65],[27,.4,.9],[28,.6,.9]]) p[i] = {x,y,visibility:1};
  if (position === 't') { p[15]={x:.05,y:.25,visibility:1}; p[16]={x:.95,y:.25,visibility:1}; }
  return p;
}
function cycle(exercise, active) {
  let state = newCycle(), result;
  for (const [time, p] of [[0,pose()],[300,pose(active)],[600,pose(active)],[900,pose()]]) { result=advanceCycle(state,assessExercise(exercise,p),time); state=result.cycle; }
  return result;
}
for (const [exercise, active] of [['squat','squat'],['arm-raises','raised'],['jumping-jacks','jack']]) {
  test(`${exercise}: a complete, stable start-active-return cycle counts once`, () => assert.equal(cycle(exercise,active).rep,true));
  test(`${exercise}: missing joints cannot complete a rep`, () => {
    let state = newCycle();
    for (const [time,p] of [[0,pose()],[300,pose(active)],[600,pose(active)]]) state=advanceCycle(state,assessExercise(exercise,p),time).cycle;
    const missing=pose(); missing[15].visibility=0; missing[16].visibility=0; missing[27].visibility=0; missing[28].visibility=0;
    assert.equal(advanceCycle(state,assessExercise(exercise,missing),900).rep,false);
  });
}
test('starting in the active position does not invent a repetition', () => {
  let state=newCycle();
  for (const time of [0,300,600]) state=advanceCycle(state,assessExercise('squat',pose('squat')),time).cycle;
  assert.equal(advanceCycle(state,assessExercise('squat',pose()),900).rep,false);
});
test('an implausibly fast active spike does not count', () => {
  let state=advanceCycle(newCycle(),assessExercise('squat',pose()),0).cycle;
  state=advanceCycle(state,assessExercise('squat',pose('squat')),100).cycle;
  assert.equal(advanceCycle(state,assessExercise('squat',pose()),200).rep,false);
});
test('bad form prevents a completed cycle from being scored', () => {
  let state=advanceCycle(newCycle(),assessExercise('squat',pose()),0).cycle;
  const bad={...assessExercise('squat',pose('squat')),good:false};
  state=advanceCycle(state,bad,300).cycle; state=advanceCycle(state,bad,600).cycle;
  const result=advanceCycle(state,assessExercise('squat',pose()),900);
  assert.equal(result.rep,false); assert.equal(result.rejected,true);
});
test('jumping jacks require feet together AND lowered arms to finish', () => {
  let state=advanceCycle(newCycle(),assessExercise('jumping-jacks',pose()),0).cycle;
  for (const time of [300,600]) state=advanceCycle(state,assessExercise('jumping-jacks',pose('jack')),time).cycle;
  assert.equal(advanceCycle(state,assessExercise('jumping-jacks',pose('raised')),900).rep,false);
});
test('pausing resets a half-completed movement; totals survive player loss', () => {
  const s=createSession('squat');
  for (const [time,p] of [[0,pose()],[300,pose('squat')],[600,pose('squat')],[900,pose()]]) updatePoses(s,[p],time);
  assert.equal(s.reps,1);
  updatePoses(s,[pose('squat')],1200); updatePoses(s,[pose('squat')],1500);
  suspendTracking(s); updatePoses(s,[pose()],1800); assert.equal(s.reps,1);
  updatePoses(s,[],9000); assert.equal(s.players.length,0); assert.equal(s.reps,1);
});
test('a stale frame gap cannot finish an old repetition', () => {
  const s=createSession('squat');
  updatePoses(s,[pose()],0); updatePoses(s,[pose('squat')],300); updatePoses(s,[pose('squat')],600); updatePoses(s,[pose()],8000);
  assert.equal(s.reps,0);
});
test('image aspect ratio is applied before joint-angle assessment', () => {
  const s=createSession('squat');
  for (const [time,p] of [[0,pose()],[300,pose('squat')],[600,pose('squat')],[900,pose()]]) updatePoses(s,[p.map(v=>({...v,x:v.x/2}))],time,2);
  assert.equal(s.reps,1);
});
test('mimic scores a sustained pose and changes the target', () => {
  const s=createSession('mimic'); for(let time=0;time<=2100;time+=300) updatePoses(s,[pose('t')],time);
  assert.equal(s.points,1); assert.equal(s.target,1);
});
test('mimic handles mirrored camera coordinates and resets a broken hold', () => {
  const s=createSession('mimic'); const mirrored=pose('t').map(p=>({...p,x:1-p.x}));
  updatePoses(s,[mirrored],0); updatePoses(s,[mirrored],300); updatePoses(s,[pose()],600); updatePoses(s,[mirrored],900);
  assert.equal(s.points,0); assert.equal(s.players[0].hold,0);
});
test('freeze rounds award movement followed by stillness, not stationary play', () => {
  for (const dance of [true,false]) {
    const s=createSession('freeze');
    for(let time=0;time<10000;time+=250) {
      let p=pose(); if(dance && freezePhase(s.elapsed)==='MOVE') p=p.map(v=>({...v,x:v.x+(time%500 ? .05 : 0)}));
      updatePoses(s,[p],time); tickSession(s,250);
    }
    assert.equal(s.points,dance ? 1 : 0);
  }
});
test('trivia accepts one answer per question and completes the question set', () => {
  const s=createSession('trivia');
  for(const question of questions) { s.choice=question.answer; assert.equal(answerTrivia(s),true); assert.equal(answerTrivia(s),false); for(let i=0;i<4;i++) tickSession(s,500); }
  assert.equal(s.correct,questions.length); assert.equal(s.points,questions.length*10); assert.equal(s.done,true);
});
test('voice commands use explicit phrases and do not match negations', () => {
  assert.equal(parseVoiceCommand('Start squats!'),'squat'); assert.equal(parseVoiceCommand('resume'),'resume'); assert.equal(parseVoiceCommand('do not pause'),null); assert.equal(parseVoiceCommand('right'),'right');
});
test('two tracked players contribute independently to the group total', () => {
  const s=createSession('arm-raises');
  for(const [time,position] of [[0,'rest'],[300,'raised'],[600,'raised'],[900,'rest']]) {
    const left=pose(position).map(p=>({...p,x:p.x-.2}));
    const right=pose(position).map(p=>({...p,x:p.x+.2}));
    updatePoses(s,[right,left],time);
  }
  assert.equal(s.players.length,2); assert.equal(s.reps,2);
  assert.deepEqual(s.players.map(p=>p.reps),[1,1]);
});
test('movement after the freeze grace period prevents a round point', () => {
  const s=createSession('freeze');
  for(let time=0;time<10000;time+=250) { updatePoses(s,[pose().map(p=>({...p,x:p.x+(time%500 ? .05 : 0)}))],time); tickSession(s,250); }
  assert.equal(s.points,0);
});
test('low confidence and collapsed knees cannot claim a good squat', () => {
  const hidden=pose(); hidden[25].visibility=.2; hidden[26].visibility=.2; assert.equal(assessExercise('squat',hidden).visible,false);
  const collapsed=pose(); collapsed[25]={...collapsed[23]}; collapsed[26]={...collapsed[24]}; assert.equal(assessExercise('squat',collapsed).visible,false);
});
for (const [exercise, active] of [['squat','squat'],['arm-raises','raised'],['jumping-jacks','jack']]) {
  test(`${exercise}: slow Fire TV inference with one active frame counts a complete cycle`, () => {
    const s=createSession(exercise);
    updatePoses(s,[pose()],0); updatePoses(s,[pose(active)],1600); updatePoses(s,[pose()],3200);
    assert.equal(s.players.length,1); assert.equal(s.reps,1);
  });
}
test('a side-view squat can use the visible leg when the far leg is occluded', () => {
  const s=createSession('squat');
  for(const [time,position] of [[0,'rest'],[900,'squat'],[1800,'rest']]) {
    const p=pose(position); for(const i of [12,24,26,28]) p[i].visibility=.1;
    updatePoses(s,[p],time);
  }
  assert.equal(s.reps,1); assert.equal(s.players[0].visible,true);
});
test('session clock advances with camera frames even when no person is detected', () => {
  const s=createSession('squat');
  assert.equal(sessionClockRunning(false,true),false); assert.equal(sessionClockRunning(true,false),false);
  assert.equal(sessionClockRunning(true,true),true);
  if(sessionClockRunning(true,true)) tickSession(s,250);
  assert.equal(s.elapsed,250); assert.equal(s.reps,0); assert.equal(s.players.length,0);
});
