const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const { requireAuth } = require("../middleware/auth");
const Resume = require("../models/Resume");
const Analysis = require("../models/Analysis");

const router = express.Router();

router.use(requireAuth);

function topN(items, getKey, limit = 8) {
  const counts = new Map();
  const samples = new Map();

  for (const item of items) {
    const key = getKey(item);
    if (!key) continue;

    counts.set(key, (counts.get(key) || 0) + 1);
    if (!samples.has(key)) samples.set(key, item);
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, count]) => ({ key, count, sample: samples.get(key) }));
}

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const resumes = await Resume.find({ userId })
      .sort({ updatedAt: -1 })
      .lean();
    const resumeMap = new Map(
      resumes.map((resume) => [resume._id.toString(), resume]),
    );
    const analyses = await Analysis.find({ userId })
      .sort({ createdAt: 1 })
      .lean();

    if (!analyses.length) {
      return res.json({
        empty: true,
        totalAnalyses: 0,
        resumes: resumes.map((resume) => ({
          _id: resume._id,
          title: resume.title,
          latestVersionNumber: resume.latestVersionNumber,
        })),
      });
    }

    const averageScore = Math.round(
      analyses.reduce((total, analysis) => total + analysis.atsScore, 0) /
        analyses.length,
    );
    const bestEntry = analyses.reduce((best, analysis) =>
      analysis.atsScore > best.atsScore ? analysis : best,
    );
    const bestResume = resumeMap.get(bestEntry.resumeId.toString());
    const scoreTrend = analyses.map((analysis) => ({
      at: analysis.createdAt,
      score: analysis.atsScore,
      resumeId: analysis.resumeId,
      resumeTitle:
        resumeMap.get(analysis.resumeId.toString())?.title || "Resume",
    }));

    const allIssues = analyses.flatMap((analysis) => analysis.issues || []);
    const topIssues = topN(
      allIssues,
      (issue) => issue.title?.trim().toLowerCase(),
      6,
    ).map((row) => ({
      title: row.sample?.title || row.key,
      count: row.count,
      severity: row.sample?.severity || "medium",
    }));

    const allMissing = analyses.flatMap(
      (analysis) => analysis.keywordsMissing || [],
    );
    const allPresent = analyses.flatMap(
      (analysis) => analysis.keywordsPresent || [],
    );
    const topMissing = topN(
      allMissing,
      (keyword) => keyword.trim().toLowerCase(),
      12,
    ).map((row) => ({ keyword: row.sample, count: row.count }));
    const topPresent = topN(
      allPresent,
      (keyword) => keyword.trim().toLowerCase(),
      12,
    ).map((row) => ({ keyword: row.sample, count: row.count }));

    const resumePerformance = resumes
      .map((resume) => {
        const resumeAnalyses = analyses.filter(
          (analysis) =>
            analysis.resumeId.toString() === resume._id.toString(),
        );
        if (!resumeAnalyses.length) return null;

        const latest = resumeAnalyses[resumeAnalyses.length - 1];
        const best = resumeAnalyses.reduce((currentBest, analysis) =>
          analysis.atsScore > currentBest.atsScore ? analysis : currentBest,
        );
        const first = resumeAnalyses[0];

        return {
          resumeId: resume._id,
          title: resume.title,
          analysesCount: resumeAnalyses.length,
          latestScore: latest.atsScore,
          bestScore: best.atsScore,
          improvement: latest.atsScore - first.atsScore,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.latestScore - a.latestScore);

    res.json({
      empty: false,
      totalAnalyses: analyses.length,
      averageScore,
      bestScore: {
        value: bestEntry.atsScore,
        resumeId: bestEntry.resumeId,
        resumeTitle: bestResume?.title || "Resume",
        at: bestEntry.createdAt,
      },
      scoreTrend,
      topIssues,
      topMissingKeywords: topMissing,
      topPresentKeywords: topPresent,
      resumePerformance,
    });
  }),
);

module.exports = router;
