// Verified against the linked publications on 2026-09-15.
// Publication titles remain in their original language.
export const metricSources = [
  {
    metric: "bmi",
    method: "bmiMethod",
    references: [
      {
        title: "CDC · Adult BMI Categories",
        url: "https://www.cdc.gov/bmi/adult-calculator/bmi-categories.html",
      },
    ],
  },
  {
    metric: "bodyFat",
    method: "bodyFatMethod",
    references: [
      {
        title: "U.S. Army · AR 600–9 (2019), Table B–5 · Body-fat equations (PDF)",
        url: "https://tripler.tricare.mil/Portals/138/Army%20Body%20Compostion%20Program.pdf#page=40",
      },
      {
        title: "ACE · Anthropometric Measurements: When to Use this Assessment (2014)",
        url: "https://www.acefitness.org/fitness-certifications/ace-answers/exam-preparation-blog/3815/anthropometric-measurements-when-to-use-this-assessment/",
      },
    ],
  },
  {
    metric: "ffmi",
    method: "ffmiMethod",
    references: [
      {
        title:
          "Schutz, Kyle & Pichard (2002) · Fat-free mass index and fat mass index percentiles in Caucasians aged 18–98 y",
        url: "https://pubmed.ncbi.nlm.nih.gov/12080449/",
      },
    ],
  },
  { metric: "trend", method: "trendHelp", references: [] },
  { metric: "shoulderWaistRatio", method: "ratioMethod", references: [] },
] as const;
