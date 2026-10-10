// Keep machine-readable evidence and the human/LLM summary consistent.
export function recordingMetadata(result) {
  return {
    sessionId: result.sessionId, state: result.state, completionReason: result.completionReason,
    dir: result.dir, backend: result.backend, target: result.target,
    timingSource: result.timingSource, requested: result.requested, actual: result.actual,
    quality: result.quality, warnings: result.warnings || [], errors: result.errors || [],
    frameCount: result.frameCount,
    composedIndices: result.contactSheet?.composedIndices || [],
    frames: result.frames,
    ...(result.clips ? { clips: result.clips.map((c) => ({ markIndex: c.markIndex,
      frameCount: c.frameCount, frames: c.frames, composedIndices: c.contactSheet?.composedIndices || [] })) } : {}),
  };
}

export function evidenceSummary(result) {
  const actual = result.actual || {};
  const achieved = actual.fps == null ? 'unknown (fewer than two distinct frame times)' : `${actual.fps.toFixed(2)} fps`;
  const gap = actual.maxFrameGapMs == null ? 'unknown' : `${actual.maxFrameGapMs.toFixed(1)}ms`;
  const target = result.target;
  const bounds = target?.bounds;
  const notes = [
    `Evidence: ${result.quality?.status || 'unknown'}; state ${result.state}; completion ${result.completionReason}.`,
    `Requested ${result.requested?.fps ?? result.fps} fps; achieved ${achieved}; largest frame gap ${gap}. Timing source: ${result.timingSource || 'unknown'}.`,
    `Sampling cannot exclude events occurring between captured frames.`,
    target ? `Actual target: ${target.region}${target.windowId ? ` window ID ${target.windowId}` : ''}${target.title ? ` (${target.title})` : ''}${bounds ? `; resolved bounds ${bounds.width}×${bounds.height} @ ${bounds.x},${bounds.y}` : ''}; method ${target.captureMethod || 'unknown'}.` : '',
    ...(result.warnings || []).map((w) => `Warning: ${w}`),
    ...(result.errors || []).map((e) => `Error: ${e}`),
  ];
  return notes.filter(Boolean).join('\n');
}
