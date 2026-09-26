// This file is required for Expo/React Native SQLite migrations - https://orm.drizzle.team/quick-sqlite/expo

import journal from "./meta/_journal.json";
import m0000 from "./0000_bitter_mister_fear.sql";
import m0001 from "./0001_fuzzy_mulholland_black.sql";
import m0002 from "./0002_curious_raza.sql";
import m0003 from "./0003_gray_proteus.sql";
import m0004 from "./0004_handy_cannonball.sql";
import m0005 from "./0005_cooing_tempest.sql";
import m0006 from "./0006_spotty_ser_duncan.sql";
import m0007 from "./0007_reflective_golden_guardian.sql";
import m0008 from "./0008_late_marauders.sql";
import m0009 from "./0009_organic_terrax.sql";
import m0010 from "./0010_fast_recent_foods.sql";
import m0011 from "./0011_weight_time_index.sql";
import m0012 from "./0012_weight_excluded.sql";

export default {
  journal,
  migrations: {
    m0000,
    m0001,
    m0002,
    m0003,
    m0004,
    m0005,
    m0006,
    m0007,
    m0008,
    m0009,
    m0010,
    m0011,
    m0012,
  },
};
