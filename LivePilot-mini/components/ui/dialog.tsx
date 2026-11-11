"use client";
import { X } from "lucide-react";
import { Button } from "./button";
export function Dialog({ open, title, description, onClose, children, wide = false }: { open: boolean; title: string; description?: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  if (!open) return null;
  return <div className="dialog-backdrop"><section className={`dialog ${wide ? "dialog-wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby="dialog-title"><header><div><h2 id="dialog-title">{title}</h2>{description && <p>{description}</p>}</div><Button variant="ghost" size="icon" aria-label="Close dialog" onClick={onClose}><X size={18}/></Button></header>{children}</section></div>;
}
