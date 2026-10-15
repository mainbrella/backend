const ACKNOWLEDGMENTS = ['Mm-hmm.', 'Okay.', 'Ah-huh.'];
const HOLD_PHRASES = ['One moment.', 'Just a moment.', 'Bear with me a moment.'];
export const voiceAcknowledgment = (turn: number) => ACKNOWLEDGMENTS[Math.max(0,turn-1) % ACKNOWLEDGMENTS.length];
export const isVoiceBackchannel = (text: string) => [...ACKNOWLEDGMENTS,...HOLD_PHRASES].includes(text.trim());
type VoiceTextPart = {type:'text-delta';text:string} | {type:'text-end'} | {type:'error';error:unknown};

/** Keep acknowledgments in the same ordered, interruptible TTS stream as the reply. */
export function withVoiceBackchannel(reply: Promise<string>, signal: AbortSignal, turn: number): AsyncGenerator<VoiceTextPart> {
  // Handle rejection even if an interrupted stream stops consuming the reply.
  const result = reply.then(text=>({type:'text-delta' as const,text}),error=>({type:'error' as const,error}));
  return streamBackchannel(result,signal,turn);
}

async function* streamBackchannel(result: Promise<VoiceTextPart>, signal: AbortSignal, turn: number): AsyncGenerator<VoiceTextPart> {
  const startedAt = Date.now();
  let onAbort!: () => void;
  const aborted = new Promise<null>(resolve=>{ onAbort=()=>resolve(null); });
  signal.addEventListener('abort',onAbort,{once:true});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const index = Math.max(0,turn-1) % ACKNOWLEDGMENTS.length;
  try {
    if (signal.aborted) return;
    for (const [afterMs,text] of [[0,ACKNOWLEDGMENTS[index]], [5000,HOLD_PHRASES[index]]] as const) {
      const waiting = new Promise<undefined>(resolve=>{
        timer=setTimeout(()=>resolve(undefined),Math.max(0,startedAt+afterMs-Date.now()));
      });
      const next = await Promise.race([result,aborted,waiting]);
      clearTimeout(timer);
      timer=undefined;
      if (signal.aborted || next===null) return;
      if (next) { yield next; return; }
      yield {type:'text-delta',text:`${text} `};
      // Explicitly end the text segment: the SDK buffers very short sentences
      // such as "Okay." until a segment boundary, even with punctuation.
      yield {type:'text-end'};
    }
    const next = await Promise.race([result,aborted]);
    if (next && !signal.aborted) yield next;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort',onAbort);
  }
}
