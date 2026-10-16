- A `gate.json` or privileged-users file saved as UTF-8 with a leading BOM
  now loads; before, `JSON.parse` rejected the invisible U+FEFF and the gate
  kept its previous config with an error (#395).
