/**
 * The landing paints its first frame before it asks for its web fonts: its headline has its own small preloaded faces,
 * and everything else starts in the metric-matched fallbacks next/font generates ("Fraunces Fallback",
 * "Figtree Fallback"). This inline script marks <html data-painted> once the first contentful paint is in (or after 3 s,
 * or at once where paint timing is not available); the CSS switches the landing to Fraunces, Figtree and Fragment Mono
 * from then on, and the canvas engines start after it (afterFirstPaint in lib/motion.ts).
 */
export const FIRST_PAINT_SCRIPT =
  "(function(){var d=document.documentElement;function on(){d.setAttribute('data-painted','')}" +
  "setTimeout(on,3000);try{if(PerformanceObserver.supportedEntryTypes.indexOf('paint')<0)return on();" +
  "new PerformanceObserver(function(l,o){if(l.getEntries().some(function(e){return e.name==='first-contentful-paint'})){o.disconnect();requestAnimationFrame(on)}})" +
  ".observe({type:'paint',buffered:true})}catch(e){on()}})()";
