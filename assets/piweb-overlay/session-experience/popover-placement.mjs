export function artifactsPopoverPlacement(anchor, width, height) {
  const panelWidth=Math.min(390,Math.max(0,width-24));
  return {width:panelWidth,left:Math.max(12,Math.min(width-panelWidth-12,anchor.right-panelWidth)),top:Math.min(anchor.bottom+6,Math.max(12,height-120))};
}
