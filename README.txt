Binderscope bundle
==================

Open index.html in a browser (Chrome, Edge, Firefox or Safari). Everything runs from this folder, offline, with no server:
the pages load their data from data/*.js, the structures are in structures/, and 3Dmol.js is in assets/.

  index.html      overview of the runs, what stands out, the build record
  board.html      family board: tiles, verdicts, diversity, decisions, order list
  inspector.html  one design in depth, findings linked to the 3D view
  map.html        binding modes, hotspot coverage, species and paralog specificity
  query.html      rule stack with a funnel, near-miss rescue, plain-words query
  data/           campaign, inspect, homolog, profile and manifest (JSON for tools, JS for the pages)
  structures/     the design models placed on the reference chain (PDB)
  reviews/        put saved review files here (the board's "Save review file" downloads one)

Scores are screens, not verdicts. data/manifest.json records the tool version, the input hashes, the thresholds and the checks
made at build time. It records file and folder names only (the absolute paths of the machine that built the bundle are cut off) but copies the
settings of each run: read it before sharing the bundle outside your lab.
