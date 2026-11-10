"use client";
import { useEffect } from "react";
import { installSelectionCopy } from "@/lib/clipboard";

export function ClipboardSelection() {
  useEffect(() => installSelectionCopy(), []);
  return null;
}
