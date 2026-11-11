"use client";

import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Plus, RefreshCw, ShieldCheck, UsersRound } from "lucide-react";
import { StreamlabsModeCard } from "@/components/dashboard/streamlabs-mode-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import type { StreamlabsState } from "@/lib/automation/streamlabs-controller";

type Account = { id: string; displayName: string; channelName?: string | null; status: string };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Request failed.");
  return body;
}

export function MiniControl() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [mode, setMode] = useState<StreamlabsState | null>(null);
  const [busy, setBusy] = useState(false);
  const [isLocal, setIsLocal] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    const [nextAccounts, nextMode] = await Promise.all([
      request<Account[]>("/api/accounts"),
      request<StreamlabsState>("/api/streamlabs"),
    ]);
    setAccounts(nextAccounts);
    setMode(nextMode);
  }, []);

  useEffect(() => {
    setIsLocal(["localhost", "127.0.0.1"].includes(window.location.hostname));
    refresh().catch(cause => setError(cause instanceof Error ? cause.message : "Could not load the project."));
  }, [refresh]);

  const connect = async () => {
    setBusy(true); setError(""); setNotice("");
    const browser = isLocal ? null : window.open("/browser/vnc.html?autoconnect=true&resize=scale&path=browser/websockify", "livepilot-browser-console", "popup,width=1280,height=900");
    try {
      await request<Account>("/api/accounts", { method: "POST" });
      setNotice(isLocal ? "A Chrome window opened. Sign in to YouTube, close Chrome, then confirm the account below." : "Browser console opened. Sign in to YouTube, close the Chrome window, then confirm the account below.");
      await refresh();
      if (!isLocal && !browser) setNotice("Account browser started. Allow popups, then open the browser console from this page to sign in.");
    } catch (cause) {
      browser?.close();
      setError(cause instanceof Error ? cause.message : "Could not start account sign-in.");
    } finally { setBusy(false); }
  };

  const check = async (account: Account) => {
    setBusy(true); setError(""); setNotice("");
    try {
      await request(`/api/accounts/${account.id}/check`, { method: "POST" });
      await refresh();
      setNotice("Account status refreshed.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not check account."); }
    finally { setBusy(false); }
  };

  const reconnect = async (account: Account) => {
    setBusy(true); setError(""); setNotice("");
    const browser = isLocal ? null : window.open("/browser/vnc.html?autoconnect=true&resize=scale&path=browser/websockify", "livepilot-browser-console", "popup,width=1280,height=900");
    try {
      await request(`/api/accounts/${account.id}/open`, { method: "POST", body: JSON.stringify({ reconnect: true }) });
      setNotice(isLocal ? "A Chrome window opened. Sign in to YouTube, close Chrome, then confirm the account." : "Browser console opened for sign-in. Close its Chrome window when finished, then confirm the account.");
      await refresh();
      if (!isLocal && !browser) setNotice("Account browser started. Allow popups, then open the browser console from this page to sign in.");
    } catch (cause) { browser?.close(); setError(cause instanceof Error ? cause.message : "Could not reconnect account."); }
    finally { setBusy(false); }
  };

  return <main className="mini-shell">
    <header className="mini-header">
      <div className="mini-brand"><span className="brand-mark"><UsersRound size={18}/></span><div><b>Streamlabs Rounds</b><small>Multi account command runner</small></div></div>
      {!isLocal && <a className="btn btn-outline" href="/browser/vnc.html?autoconnect=true&resize=scale&path=browser/websockify" target="_blank" rel="noreferrer"><ExternalLink size={15}/>Browser console</a>}
    </header>
    <p className="mini-intro">Connect the YouTube accounts you want to use, choose their round messages, and start listening for Streamlabs announcements.</p>
    <Card className="mini-accounts">
      <CardHeader className="section-heading"><div><h2><UsersRound size={18}/> YouTube accounts</h2><p>Each account keeps its own saved browser session.</p></div><Button disabled={busy} onClick={connect}><Plus size={16}/>Connect account</Button></CardHeader>
      <CardContent className="mini-account-list">
        {!accounts.length && <p className="helper">No accounts yet. Connect one to begin.</p>}
        {accounts.map(account => <div className="mini-account" key={account.id}><span className={`mini-dot ${account.status === "CONNECTED" ? "ready" : ""}`}/><div><b>{account.displayName}</b><small>{account.channelName || account.status.replaceAll("_", " ")}</small></div><div className="mini-account-actions">{account.status === "CONNECTED" ? <Button variant="outline" disabled={busy} onClick={() => check(account)}><RefreshCw size={14}/>Check</Button> : <Button variant="outline" disabled={busy} onClick={() => reconnect(account)}><RefreshCw size={14}/>Sign in again</Button>}</div></div>)}
        <p className="mini-auth-note"><ShieldCheck size={15}/>Sign in manually in the browser console. The app does not ask for or store your Google password.</p>
      </CardContent>
    </Card>
    {notice && <p className="mini-notice" role="status">{notice}</p>}
    {error && <p className="mini-error" role="alert">{error}</p>}
    <StreamlabsModeCard state={mode} automations={[]} refresh={refresh}/>
    <footer className="mini-footer">Use accounts that are permitted to chat on the selected livestream. YouTube may restrict or reject messages.</footer>
  </main>;
}
