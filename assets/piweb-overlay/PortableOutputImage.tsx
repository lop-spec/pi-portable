"use client";

import { useState, type ImgHTMLAttributes } from "react";
import { ImagePreview } from "./ImagePreview";

export function PortableOutputImage({ src, alt = "", ...props }: ImgHTMLAttributes<HTMLImageElement>) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (typeof src !== "string" || !src) {
    return <span role="status">图片地址无效{alt ? `：${alt}` : ""}</span>;
  }
  if (failedSrc === src) {
    return <span role="status">图片加载失败{alt ? `：${alt}` : ""} <a href={src} target="_blank" rel="noopener noreferrer">打开原图</a> <button type="button" onClick={() => setFailedSrc(null)}>重试</button></span>;
  }
  return (
    <ImagePreview src={src} alt={alt} style={{ display: "inline-block", maxWidth: "100%" }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img {...props} src={src} alt={alt} loading="lazy" style={{ maxWidth: "100%", maxHeight: 480, objectFit: "contain", ...props.style }} onError={() => {
        console.error("[pi-web] output image load failed:", src);
        setFailedSrc(src);
      }} />
    </ImagePreview>
  );
}
