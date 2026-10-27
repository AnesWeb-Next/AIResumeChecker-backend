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
    const resumes = await Resume.find({ userId }).lean();
    const resumeIds = resumes.map((resume) => resume._id);
    const resumeMap = new Map(
      resumes.map((resume) => [resume._id.toString(), resume]),
    );

    const [versions, analyses] = await Promise.all([
      ResumeVersion.find({ resumeId: { $in: resumeIds } })
        .select("_id resumeId label sourceType createdAt")
        .lean(),
      Analysis.find({ userId })
        .select("_id resumeId versionId atsScore createdAt")
        .lean(),
    ]);

    const events = resumes.map((resume) => ({
      id: `r-${resume._id}`,
      type: "upload",
      title: `${resume.title} uploaded`,
      subtitle: "Parsed and version V1 created",
      label: "V1",
      at: resume.createdAt,
      resumeId: resume._id,
      resumeTitle: resume.title,
    }));

    for (const version of versions) {
      if (version.sourceType !== "rewrite") continue;
      const resume = resumeMap.get(version.resumeId.toString());
      events.push({
        id: `v-${version._id}`,
        type: "rewrite",
        title: `${version.label} created for ${resume?.title || "resume"}`,
        subtitle: "Rewrites applied to previous version",
        label: `${version.label} created`,
        at: version.createdAt,
        resumeId: version.resumeId,
        resumeTitle: resume?.title || "Resume",
      });
    }

    for (const analysis of analyses) {
      const resume = resumeMap.get(analysis.resumeId.toString());
      events.push({
        id: `a-${analysis._id}`,
        type: "analyze",
        title: `Analysis complete on ${resume?.title || "resume"}`,
        subtitle: `ATS score ${analysis.atsScore} / 100`,
        label: `${analysis.atsScore}`,
        at: analysis.createdAt,
        resumeId: analysis.resumeId,
        resumeTitle: resume?.title || "Resume",
      });
    }

    events.sort(
      (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
    );

    const totals = {
      all: events.length,
      upload: events.filter((event) => event.type === "upload").length,
      analyze: events.filter((event) => event.type === "analyze").length,
      rewrite: events.filter((event) => event.type === "rewrite").length,
    };

    res.json({ events, totals });
  }),
);

module.exports = router;
