"use client";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

/** Renders sheets at <body> so a parent's transform / backdrop-filter can't trap position: fixed. */
export function Portal({ children }: { children: React.ReactNode }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => setEl(document.body), []);
  return el ? createPortal(children, el) : null;
}
