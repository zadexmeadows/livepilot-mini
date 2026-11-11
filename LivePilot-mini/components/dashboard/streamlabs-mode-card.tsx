"use client";

import { useEffect, useRef, useState } from "react";
import { Pause, Play, Radio, Save, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import type { StreamlabsConfig, StreamlabsState } from "@/lib/automation/streamlabs-controller";

type Account = { id: string; displayName: string; channelName?: string | null; status: string };
type Log = { id: string; action: string; message: string; createdAt: string };

const initialConfig: StreamlabsConfig = {
  youtubeUrl: "", accountIds: [], messages: [], delaySeconds: 10, fallbackSeconds: 300, noMessageRepeats: false,
  heistWager: 1337, bankAccountId: null, bankPresenceMessage: ".",
  bankPresenceSeconds: 120, protectedReserve: 1337, minimumTransfer: 100, maximumTransfer: 5000,
  responseTimeoutSeconds: 20, autoConsolidate: false,
};

export function StreamlabsModeCard({ state, refresh }: { state: StreamlabsState | null; automations: { googleAccount: Account }[]; refresh: () => Promise<void> }) {
  const [form, setForm] = useState<StreamlabsConfig>(initialConfig);
  const [messageText, setMessageText] = useState("");
  const hydrated = useRef(false);
  const urlInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [saved, setSaved] = useState(""), [accounts, setAccounts] = useState<Account[]>([]), [logs, setLogs] = useState<Log[]>([]);
  const active = state?.enabled ?? false, editable = !active;
  useEffect(() => { if (state && (!hydrated.current || state.enabled)) { hydrated.current = true; setForm(state.config); setMessageText(state.config.messages.join("\n")); } }, [state]);
  useEffect(() => { Promise.all([fetch("/api/accounts").then(response => response.json()), fetch("/api/logs?take=50").then(response => response.json())]).then(([nextAccounts, nextLogs]) => { setAccounts(nextAccounts); setLogs(nextLogs.filter((log: Log) => log.action.startsWith("STREAMLABS_"))); }).catch(() => undefined); }, [state]);
  const submit = async (action: "save" | "save-url" | "start" | "pause" | "stop" | "check-points" | "sweep-points" | "cancel-points") => {
    setBusy(true); setError(""); setSaved("");
    try {
      const config = { ...form, messages: messageText.split("\n").map(value => value.trim()).filter(Boolean) };
      const body = action === "save-url" ? { action, youtubeUrl: urlInput.current?.value.trim() || form.youtubeUrl.trim() } : action === "save" || action === "start" ? { action, config } : { action };
      const response = await fetch("/api/streamlabs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || "Could not update Streamlabs Mode.");
      if (action === "save-url") { setForm(result.config); setSaved("Livestream URL saved."); }
      else if (action === "save") setSaved("Streamlabs settings saved.");
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update Streamlabs Mode."); } finally { setBusy(false); }
  };
  const toggleAccount = (id: string) => setForm(value => ({ ...value, accountIds: value.accountIds.includes(id) ? value.accountIds.filter(item => item !== id) : [...value.accountIds, id] }));
  const setMonitor = (id: string) => setForm(value => ({ ...value, accountIds: [id, ...value.accountIds.filter(item => item !== id)] }));
  const current = state?.participants.find(account => account.id === state.currentAccountId);

  return <Card className={`streamlabs-card ${active ? "streamlabs-on" : ""}`}>
    <CardHeader className="section-heading wrap"><div><h2><Radio size={19}/> Streamlabs Mode</h2><p>Listen for round announcements and send your selected commands from each account.</p></div><div className="streamlabs-controls"><span className="streamlabs-phase" role="status">{state?.phase ?? "OFF"}</span>{active ? <><Button variant="secondary" disabled={busy} onClick={() => submit("pause")}><Pause size={15}/>Pause</Button><Button variant="danger" disabled={busy} onClick={() => submit("stop")}><Square size={14}/>Stop</Button></> : <Button disabled={busy} onClick={() => submit("start")}><Play size={15}/>{state?.phase === "PAUSED" ? "Resume" : "Start"}</Button>}</div></CardHeader>
    <CardContent className="streamlabs-layout"><div className="streamlabs-settings">
      <div className="streamlabs-url-row"><label className="field"><span>Livestream URL</span><input ref={urlInput} disabled={!editable} value={form.youtubeUrl} onChange={event => { setSaved(""); setForm(value => ({ ...value, youtubeUrl: event.target.value })); }} placeholder="https://www.youtube.com/watch?v=…"/></label><Button variant="secondary" disabled={!editable || busy || !form.youtubeUrl.trim()} onClick={() => submit("save-url")}><Save size={15}/>Save URL</Button></div>
      <div className="streamlabs-number-grid"><label className="field"><span>Delay between accounts (seconds)</span><input disabled={!editable} type="number" min={1} max={3600} value={form.delaySeconds} onChange={event => setForm({ ...form, delaySeconds: Number(event.target.value) })}/></label><label className="field"><span>Fallback round after no announcement (seconds)</span><input disabled={!editable} type="number" min={10} max={86400} value={form.fallbackSeconds} onChange={event => setForm({ ...form, fallbackSeconds: Number(event.target.value) })}/></label></div>
      <div className="field"><span>Accounts</span><small className="helper">Identity is taken automatically from the YouTube channel handle detected for each connected account. The first selected account watches announcements.</small><div className="streamlabs-accounts">{accounts.map(account => { const isSelected = form.accountIds.includes(account.id), monitor = form.accountIds[0] === account.id, connected = account.status === "CONNECTED"; return <div key={account.id} className="streamlabs-account-row"><label><input disabled={!editable || (!connected && !isSelected)} type="checkbox" checked={isSelected} onChange={() => toggleAccount(account.id)}/><span>{account.displayName}<small>{connected ? account.channelName || "Channel handle not detected" : `${account.status.replaceAll("_", " ")} — reconnect in Google Accounts`}</small></span></label>{isSelected && connected && <button type="button" disabled={!editable || monitor} onClick={() => setMonitor(account.id)}>{monitor ? "Watching" : "Make watcher"}</button>}</div>; })}</div></div>
      <label className="field"><span>Message pool (one message per line)</span><textarea disabled={!editable} rows={4} value={messageText} onChange={event => setMessageText(event.target.value)} placeholder={'!heist 1337\nJoining now'}/></label>
      <div className="streamlabs-check"><input id="streamlabs-no-repeats" disabled={!editable} type="checkbox" checked={form.noMessageRepeats} onChange={event => setForm({ ...form, noMessageRepeats: event.target.checked })}/><label htmlFor="streamlabs-no-repeats"><b>No message repeats per round</b><small>When off, each account independently chooses from the pool and repeats are allowed.</small></label></div>
      {editable && <Button variant="secondary" disabled={busy} onClick={() => submit("save")}><Save size={15}/>Save settings</Button>}
      {saved && <p role="status" className="points-positive">{saved}</p>}
    </div><div className="streamlabs-status-panel"><h3>Mode status</h3><dl><div><dt>Round</dt><dd>{state?.round ?? 0}</dd></div><div><dt>Last trigger</dt><dd>{state?.lastRoundTrigger?.toLowerCase() ?? "—"}</dd></div><div><dt>Current account</dt><dd>{current?.name ?? "—"}</dd></div><div><dt>Next action</dt><dd>{state?.nextActionAt ? new Date(state.nextActionAt).toLocaleTimeString() : "—"}</dd></div></dl>{state?.reason && <p role="status" className="helper">{state.reason}</p>}{error && <p role="alert" className="streamlabs-error">{error}</p>}
      <h3>Streamlabs logs</h3><div className="streamlabs-logs">{logs.slice(0, 5).map(log => <div key={log.id}><time>{new Date(log.createdAt).toLocaleTimeString()}</time><span>{log.message}</span></div>)}{!logs.length && <p className="helper">No Streamlabs activity yet.</p>}</div>
    </div></CardContent>
  </Card>;
}
