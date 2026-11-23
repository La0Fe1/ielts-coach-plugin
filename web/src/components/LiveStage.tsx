import { useEffect, useRef } from 'react';
import type { TranscriptLine, TurnFeedback } from '@ielts/shared';
import { FeedbackCard } from './FeedbackCard';

export interface CueState {
  text: string;
  stage: 'prep' | 'speak';
  remaining: number;
}

export function LiveStage(props: {
  lines: TranscriptLine[];
  draftUser: string;
  draftExaminer: string;
  orb: 'idle' | 'listening' | 'speaking' | 'thinking';
  partLabel: string;
  questionIndex: number;
  questionCount: number;
  muted: boolean;
  handsFree: boolean;
  speakerMode: boolean;
  captionsVisible: boolean;
  cue: CueState | null;
  feedback: TurnFeedback | null;
  feedbackIds: Record<string, boolean>;
  onToggleMute: () => void;
  onToggleHandsFree: () => void;
  onToggleSpeaker: () => void;
  onToggleCaptions: () => void;
  onCommit: () => void;
  onInterrupt: () => void;
  onEnd: () => void;
  onStartCue: () => void;
  onFinishCue: () => void;
  mobileSide: boolean;
  onToggleMobileSide: () => void;
}) {
  const bottomRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [props.lines.length, props.draftUser, props.draftExaminer]);

  const status =
    props.orb === 'speaking' ? '考官正在说' : props.orb === 'listening' ? '在听你说' : props.orb === 'thinking' ? '正在整理' : '可以开口';

  return (
    <div className={'stage' + (props.mobileSide ? ' mobile-side' : '')}>
      <main className="stage-main">
        <div className="orb-row">
          <div className={'orb ' + props.orb} />
          <div className="orb-copy">
            <strong>{status}</strong>
            <span>
              {props.partLabel} · 第 {Math.min(props.questionIndex + 1, props.questionCount)} / {props.questionCount} 题
            </span>
          </div>
          <div style={{ marginLeft: 'auto' }} className="row">
            <button className="ghost" onClick={props.onToggleMobileSide}>
              精批
            </button>
            <button className="ghost" onClick={props.onToggleCaptions}>
              {props.captionsVisible ? '盲听' : '字幕'}
            </button>
          </div>
        </div>

        <div className="pills">
          <span className="pill">{props.handsFree ? '自由通话' : '手动控场'}</span>
          <span className="pill neutral">{props.speakerMode ? '🔊 外放防回声' : '🎧 耳机全双工'}</span>
          {props.muted && <span className="pill neutral">麦克风已静音</span>}
          {!props.handsFree && <span className="pill neutral">说完点「我说完了」</span>}
        </div>

        {props.cue && (
          <div className="panel-card">
            <h3>Part 2 题卡</h3>
            <div className="cue-card">
              <pre>{props.cue.text}</pre>
            </div>
            <div className="row" style={{ marginTop: 10, alignItems: 'center' }}>
              <span className="cue-timer">
                {Math.floor(props.cue.remaining / 60)}:{String(props.cue.remaining % 60).padStart(2, '0')}
              </span>
              <span className="hint">{props.cue.stage === 'prep' ? '准备时间：可以写关键词，不会开麦' : '作答中：放心停顿，考官不会打断'}</span>
              {props.cue.stage === 'prep' ? (
                <button className="primary" onClick={props.onStartCue}>
                  提前开讲
                </button>
              ) : (
                <button className="primary" onClick={props.onFinishCue}>
                  我讲完了
                </button>
              )}
            </div>
          </div>
        )}

        <div className="subtitles">
          {props.lines.map((line) => (
            <div key={line.id} className={'line ' + line.role + (line.final ? '' : ' pending')}>
              <span className="who">{line.role === 'user' ? '你' : '考官'}</span>
              {props.captionsVisible || line.role === 'user' ? line.text : '（盲听模式，点这条可看文字）'}
              {line.role === 'user' && props.feedbackIds[line.id] && (
                <span className="badge-feedback">✨ 已生成精批</span>
              )}
            </div>
          ))}
          {props.draftExaminer && (
            <div className="line examiner pending">
              <span className="who">考官</span>
              <span className="cursor">{props.draftExaminer}</span>
            </div>
          )}
          {props.draftUser && (
            <div className="line user pending">
              <span className="who">你</span>
              <span className="cursor">{props.draftUser}</span>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        <div className="micbar">
          <button className="ghost" onClick={props.onToggleMute}>
            {props.muted ? '取消静音' : '静音'}
          </button>
          <button className={'mic-main ' + (props.handsFree ? 'mic-main' : 'mic-main active')} onClick={props.onCommit}>
            {props.handsFree ? '打断' : '我说完了'}
          </button>
          <button className="ghost" onClick={props.onToggleHandsFree}>
            {props.handsFree ? '切手动' : '切自由'}
          </button>
          <button className="ghost" onClick={props.onToggleSpeaker}>
            {props.speakerMode ? '切耳机' : '切外放'}
          </button>
          <button className="danger" onClick={props.onEnd}>
            结束
          </button>
        </div>
      </main>

      <aside className="stage-side">
        <FeedbackCard feedback={props.feedback} />
        <div className="panel-card">
          <h3>玩法</h3>
          <p className="hint">
            随时开口就能打断考官。外放模式下考官说话时会自动闭麦，点「打断」即可插话；Part 2 会自动收紧成手动模式，绝不打断你的独白。
          </p>
        </div>
      </aside>
    </div>
  );
}
