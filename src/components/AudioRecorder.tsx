import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, Square, Play, Pause, Trash2, ListMusic } from 'lucide-react';
import { AudioRecording, newId } from '../types';
import { deleteRecording, getRecordingBlob, listRecordings, saveRecording } from '../storage/db';

/**
 * Per-note audio recording (Notability's signature feature, simplified: recordings are stored with
 * the note and can be replayed; ink is not time-synced to the audio).
 */

function pickMime(): string {
  const candidates = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'];
  for (const m of candidates) if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(m)) return m;
  return '';
}

function fmt(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const AudioRecorder: React.FC<{ noteId: string; onError: (msg: string) => void }> = ({ noteId, onError }) => {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [list, setList] = useState<AudioRecording[]>([]);
  const [open, setOpen] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const startedAt = useRef(0);
  const audioEl = useRef<HTMLAudioElement | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    listRecordings(noteId).then(setList).catch(() => setList([]));
  }, [noteId]);
  useEffect(refresh, [refresh]);

  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setElapsed(Date.now() - startedAt.current), 250);
    return () => clearInterval(t);
  }, [recording]);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', close, true);
    return () => window.removeEventListener('pointerdown', close, true);
  }, [open]);

  useEffect(() => () => {
    recorder.current?.state === 'recording' && recorder.current.stop();
    audioEl.current?.pause();
  }, []);

  const start = async () => {
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Audio recording is not available in this WebView');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = pickMime();
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunks.current = [];
      rec.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks.current, { type: rec.mimeType || mime || 'audio/webm' });
        const meta: AudioRecording = { id: newId('audio'), noteId, createdAt: startedAt.current, durationMs: Date.now() - startedAt.current, mimeType: blob.type };
        await saveRecording(meta, blob);
        refresh();
      };
      rec.start(1000);
      recorder.current = rec;
      startedAt.current = Date.now();
      setElapsed(0);
      setRecording(true);
    } catch (err) {
      onError(`Microphone: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const stop = () => {
    recorder.current?.stop();
    recorder.current = null;
    setRecording(false);
  };

  const play = async (r: AudioRecording) => {
    if (playing === r.id) {
      audioEl.current?.pause();
      setPlaying(null);
      return;
    }
    const blob = await getRecordingBlob(r.id);
    if (!blob) return;
    audioEl.current?.pause();
    const a = new Audio(URL.createObjectURL(blob));
    a.onended = () => setPlaying(null);
    audioEl.current = a;
    await a.play().catch((e) => onError(String(e)));
    setPlaying(r.id);
  };

  return (
    <div ref={wrapRef} className="relative flex items-center">
      {recording ? (
        <button onClick={stop} className="flex items-center gap-1.5 bg-red-500 text-white px-2.5 py-1.5 rounded-xl text-xs font-semibold" title="Stop recording">
          <Square className="w-3 h-3 fill-current" />
          {fmt(elapsed)}
        </button>
      ) : (
        <button onClick={start} className="p-2 rounded-lg text-gray-600 dark:text-gray-300" title="Record audio">
          <Mic className="w-[18px] h-[18px]" />
        </button>
      )}
      {list.length > 0 && (
        <button onClick={() => setOpen(!open)} className="p-2 rounded-lg text-gray-600 dark:text-gray-300 relative" title="Recordings">
          <ListMusic className="w-[18px] h-[18px]" />
          <span className="absolute top-0.5 right-0.5 text-[9px] bg-blue-600 text-white rounded-full px-1">{list.length}</span>
        </button>
      )}
      {open && (
        <div className="absolute top-11 right-0 z-50 bg-white dark:bg-[#2C2C2E] rounded-2xl p-2 shadow-xl border border-gray-200 dark:border-gray-700 w-64">
          {list.map((r) => (
            <div key={r.id} className="flex items-center gap-2 px-2 py-1.5 text-xs text-gray-700 dark:text-gray-200">
              <button onClick={() => play(r)} className="p-1.5 rounded-full bg-blue-50 dark:bg-blue-900/40 text-blue-600">
                {playing === r.id ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              </button>
              <div className="flex-1">
                <div>{new Date(r.createdAt).toLocaleString()}</div>
                <div className="text-gray-400">{fmt(r.durationMs)}</div>
              </div>
              <button
                onClick={async () => {
                  await deleteRecording(r.id);
                  refresh();
                }}
                className="p-1.5 text-gray-400 hover:text-red-500"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
