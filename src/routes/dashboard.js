const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const { requireAuth } = require("../middleware/auth");
const Resume = require("../models/Resume");
const ResumeVersion = require("../models/ResumeVersion");
const Analysis = require("../models/Analysis");

const router = express.Router();

router.use(requireAuth);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const resumes = await Resume.find({ userId })
      .sort({ updatedAt: -1 })
      .lean();
    const resumeIds = resumes.map((resume) => resume._id);

    const [rewriteCount, analysisCount] = await Promise.all([
      ResumeVersion.countDocuments({
        resumeId: { $in: resumeIds },
        sourceType: "rewrite",
      }),
      Analysis.countDocuments({ userId }),
    ]);

    const latestResumeMeta = resumes[0] || null;
    let latestResume = null;
    let scoreSeries = [];
    let versionStack = [];

    if (latestResumeMeta) {
      const versions = await ResumeVersion.find({
        resumeId: latestResumeMeta._id,
      })
        .sort({ versionNumber: 1 })
        .lean();
      const analyses = await Analysis.find({
        resumeId: latestResumeMeta._id,
        versionId: { $in: versions.map((version) => version._id) },
      })
        .sort({ createdAt: -1 })
        .select("atsScore versionId")
        .lean();
      const scoreByVersion = new Map();

      for (const analysis of analyses) {
        const versionId = analysis.versionId.toString();
        if (!scoreByVersion.has(versionId)) {
          scoreByVersion.set(versionId, analysis.atsScore);
        }
      }

      const versionsWithScores = versions.map((version) => ({
        id: version._id,
        label: version.label,
        versionNumber: version.versionNumber,
        sourceType: version.sourceType,
        createdAt: version.createdAt,
        score: scoreByVersion.get(version._id.toString()) ?? null,
      }));

      latestResume = {
        _id: latestResumeMeta._id,
        title: latestResumeMeta.title,
        latestVersionNumber: latestResumeMeta.latestVersionNumber,
        updatedAt: latestResumeMeta.updatedAt,
        currentVersionId: latestResumeMeta.currentVersionId,
      };

      scoreSeries = versionsWithScores
        .filter((version) => version.score != null)
        .map((version) => ({
          label: version.label,
          score: version.score,
          versionId: version.id,
          at: version.createdAt,
        }));

      versionStack = versionsWithScores.slice(-3).map((version, index, stack) => {
        const previous = stack[index - 1];
        const delta =
          version.score != null && previous?.score != null
            ? version.score - previous.score
            : 0;

        return {
          id: version.id,
          label: version.label,
          title: version.sourceType === "upload" ? "Upload" : "Rewrite pass",
          score: version.score ?? 0,
          delta,
        };
      });
    }

    const latestAnalyses = await Analysis.find({ userId })
      .select(
        "atsScore keywordsPresent keywordsMissing issues createdAt resumeId",
      )
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();
    const latestAnalysis = latestAnalyses[0] || null;
    const previousAnalysis = latestAnalyses[1] || null;
    const chronologicalAnalyses = latestAnalyses.slice().reverse();
    const versionsSpark = resumes
      .slice(0, 10)
      .reverse()
      .map((resume) => ({ v: resume.latestVersionNumber || 1 }));
    const issuesCount = (analysis) => analysis?.issues?.length || 0;
    const keywordsCount = (analysis) => analysis?.keywordsPresent?.length || 0;

    const kpi = {
      atsScore: {
        value: latestAnalysis?.atsScore ?? null,
        delta:
          latestAnalysis && previousAnalysis
            ? latestAnalysis.atsScore - previousAnalysis.atsScore
            : null,
        spark: chronologicalAnalyses.map((analysis) => ({
          v: analysis.atsScore,
        })),
      },
      versions: {
        value: resumes.reduce(
          (total, resume) => total + (resume.latestVersionNumber || 1),
          0,
        ),
        delta: null,
        spark: versionsSpark,
      },
      issuesIdentified: {
        value: latestAnalysis ? issuesCount(latestAnalysis) : null,
        delta:
          latestAnalysis && previousAnalysis
            ? issuesCount(latestAnalysis) - issuesCount(previousAnalysis)
            : null,
        spark: chronologicalAnalyses.map((analysis) => ({
          v: issuesCount(analysis),
        })),
      },
      keywordsMatched: {
        value: latestAnalysis ? keywordsCount(latestAnalysis) : null,
        total: latestAnalysis
          ? keywordsCount(latestAnalysis) +
            (latestAnalysis.keywordsMissing?.length || 0)
          : null,
        delta:
          latestAnalysis && previousAnalysis
            ? keywordsCount(latestAnalysis) - keywordsCount(previousAnalysis)
            : null,
        spark: chronologicalAnalyses.map((analysis) => ({
          v: keywordsCount(analysis),
        })),
      },
    };

    const resumeMap = new Map(
      resumes.map((resume) => [resume._id.toString(), resume]),
    );
    const [recentVersions, recentAnalyses] = await Promise.all([
      ResumeVersion.find({
        resumeId: { $in: resumeIds },
        sourceType: "rewrite",
      })
        .sort({ createdAt: -1 })
        .limit(10)
        .select("resumeId label createdAt")
        .lean(),
      Analysis.find({ userId })
        .sort({ createdAt: -1 })
        .limit(10)
        .select("resumeId atsScore createdAt")
        .lean(),
    ]);

    const events = [];

    for (const resume of resumes.slice(0, 10)) {
      events.push({
        id: `r-${resume._id}`,
        type: "upload",
        title: `${resume.title} uploaded`,
        subtitle: "Parsed and version V1 created",
        label: "V1",
        at: resume.createdAt,
        resumeId: resume._id,
      });
    }

    for (const version of recentVersions) {
      const resume = resumeMap.get(version.resumeId.toString());
      events.push({
        id: `v-${version._id}`,
        type: "rewrite",
        title: `${version.label} created for ${resume?.title || "resume"}`,
        subtitle: "Rewrites applied",
        label: `${version.label} created`,
        at: version.createdAt,
        resumeId: version.resumeId,
      });
    }

    for (const analysis of recentAnalyses) {
      const resume = resumeMap.get(analysis.resumeId.toString());
      events.push({
        id: `a-${analysis._id}`,
        type: "analyze",
        title: `Analysis complete on ${resume?.title || "resume"}`,
        subtitle: `ATS score ${analysis.atsScore} / 100`,
        label: `${analysis.atsScore}`,
        at: analysis.createdAt,
        resumeId: analysis.resumeId,
      });
    }

    const activity = events
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
      .slice(0, 8);

    res.json({
      totals: {
        resumes: resumes.length,
        rewrites: rewriteCount,
        analyses: analysisCount,
        exports: 0,
      },
      latestResume,
      scoreSeries,
      versionStack,
      kpi,
      activity,
    });
  }),
);

module.exports = router;
