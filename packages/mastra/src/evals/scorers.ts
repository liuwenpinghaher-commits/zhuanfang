export const scorers = {
  interviewNaturalness: (transcript: string): { score: number; feedback: string } => {
    const questions = (transcript.match(/\?/g) || []).length;
    const turns = transcript.split("\n").filter((l) => l.trim()).length;
    const ratio = questions / Math.max(turns, 1);
    return {
      score: Math.min(ratio * 2, 1),
      feedback: ratio > 0.3 ? "Good question frequency" : "Consider asking more questions",
    };
  },

  followupRelevance: (transcript: string, previousTopics: string[]): { score: number; feedback: string } => {
    const lowerTranscript = transcript.toLowerCase();
    const matches = previousTopics.filter((t) => lowerTranscript.includes(t.toLowerCase()));
    const score = matches.length / Math.max(previousTopics.length, 1);
    return { score, feedback: score > 0.5 ? "Good topic continuity" : "Follow-ups could be more relevant" };
  },

  memoryCitation: (response: string, memories: string[]): { score: number; feedback: string } => {
    const hasCitation = memories.some((m) => response.includes(m.slice(0, 10)));
    return { score: hasCitation ? 0.9 : 0.3, feedback: hasCitation ? "Memory referenced" : "No memory citation found" };
  },

  memoryCandidatePrecision: (candidate: { text: string; evidenceQuote: string }): { score: number; feedback: string } => {
    const textWords = new Set(candidate.text.toLowerCase().split(/\s+/));
    const evidenceWords = new Set(candidate.evidenceQuote.toLowerCase().split(/\s+/));
    const overlap = [...textWords].filter((w) => evidenceWords.has(w)).length;
    const score = overlap / Math.max(textWords.size, 1);
    return { score, feedback: score > 0.3 ? "Good evidence alignment" : "Weak evidence support" };
  },

  sensitiveLeakage: (content: string): { score: number; feedback: string } => {
    const patterns = [/\b\d{11}\b/, /\b\d{18}\b/, /\b(password|secret|token|key)\b/i, /\b\d{16,19}\b/];
    const leaks = patterns.filter((p) => p.test(content));
    return { score: leaks.length === 0 ? 1 : 0, feedback: leaks.length === 0 ? "No sensitive data detected" : `Found ${leaks.length} potential leaks` };
  },

  contextPackRelevance: (pack: any, sessionTopic: string): { score: number; feedback: string } => {
    const packStr = JSON.stringify(pack).toLowerCase();
    const relevance = packStr.includes(sessionTopic.toLowerCase());
    return { score: relevance ? 0.8 : 0.3, feedback: relevance ? "Context pack relevant" : "Context pack may be off-topic" };
  },

  sourceFaithfulness: (claim: string, source: string): { score: number; feedback: string } => {
    const claimWords = claim.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    const sourceLower = source.toLowerCase();
    const faithful = claimWords.filter((w) => sourceLower.includes(w)).length;
    const score = faithful / Math.max(claimWords.length, 1);
    return { score, feedback: score > 0.5 ? "Claims supported by source" : "Claims may deviate from source" };
  },

  interviewFeedback: (feedbacks: { rating: number }[]): { score: number; feedback: string } => {
    if (feedbacks.length === 0) return { score: 0, feedback: "No feedback collected" };
    const avg = feedbacks.reduce((sum, f) => sum + f.rating, 0) / feedbacks.length;
    return { score: avg / 5, feedback: `Average rating: ${avg.toFixed(1)}/5 from ${feedbacks.length} reviews` };
  },
};
