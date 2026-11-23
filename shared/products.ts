/*
 * The name Roborock sells a model under, from the technical model string the robot reports
 * (roborock.vacuum.a101 -> "Roborock Qrevo Pro"). Ported from LocalRock's ProductCatalog.kt, itself
 * from local_roborock_server's product_catalog.json. A model not listed is shown as reported.
 */
const NAMES: Record<string, string> = {
  'roborock.vacuum.a08': 'Roborock S6 Pure',
  'roborock.vacuum.a10': 'Roborock S6 MaxV',
  'roborock.vacuum.a101': 'Roborock Qrevo Pro',
  'roborock.vacuum.a104': 'Roborock Qrevo S',
  'roborock.vacuum.a117': 'Roborock Qrevo Master',
  'roborock.vacuum.a123': 'Roborock Qrevo Plus',
  'roborock.vacuum.a125': 'Roborock Q5 Max+',
  'roborock.vacuum.a135': 'Roborock Qrevo Curv',
  'roborock.vacuum.a140': 'Roborock Q5 DuoRoller+',
  'roborock.vacuum.a144': 'Roborock Saros 10R',
  'roborock.vacuum.a147': 'Roborock Saros 10',
  'roborock.vacuum.a15': 'Roborock S7',
  'roborock.vacuum.a156': 'Roborock Qrevo Edge',
  'roborock.vacuum.a159': 'Roborock Qrevo Curv Series',
  'roborock.vacuum.a168': 'Roborock Qrevo L',
  'roborock.vacuum.a170': 'Roborock Qrevo C',
  'roborock.vacuum.a179': 'Roborock Saros Z70',
  'roborock.vacuum.a185': 'Roborock Qrevo CurvX',
  'roborock.vacuum.a187': 'Roborock Qrevo Edge Series',
  'roborock.vacuum.a19': 'Roborock S4 Max',
  'roborock.vacuum.a197': 'Roborock Qrevo EdgeT',
  'roborock.vacuum.a199': 'Roborock QV 35A',
  'roborock.vacuum.a205': 'Roborock QR 598',
  'roborock.vacuum.a21': 'Roborock Qrevo Slim',
  'roborock.vacuum.a245': 'Roborock Qrevo Curv 2 Flow',
  'roborock.vacuum.a246': 'Roborock QX Revo Arc',
  'roborock.vacuum.a27': 'Roborock S7 MaxV',
  'roborock.vacuum.a279': 'Roborock Saros 20 Sonic',
  'roborock.vacuum.a288': 'Roborock Saros 20',
  'roborock.vacuum.a294': 'Roborock Qrevo 2 Pro Series',
  'roborock.vacuum.a296': 'Roborock Qrevo Edge 3 Pro',
  'roborock.vacuum.a298': 'Roborock Qrevo Edge 2',
  'roborock.vacuum.a30': 'Roborock G10',
  'roborock.vacuum.a307': 'Roborock Saros 20 Flow',
  'roborock.vacuum.a326': 'Roborock Qrevo S Pro Series',
  'roborock.vacuum.a34': 'Roborock Q5',
  'roborock.vacuum.a38': 'Roborock Q7 Max',
  'roborock.vacuum.a40': 'Roborock Q7',
  'roborock.vacuum.a51': 'Roborock S8',
  'roborock.vacuum.a65': 'Roborock S7 Max Ultra',
  'roborock.vacuum.a70': 'Roborock S8 Pro Ultra',
  'roborock.vacuum.a72': 'Roborock Q5 Pro',
  'roborock.vacuum.a73': 'Roborock Q8 Max',
  'roborock.vacuum.a75': 'Roborock Q Revo',
  'roborock.vacuum.a87': 'Roborock Qrevo MaxV',
  'roborock.vacuum.a95': 'Roborock S8 Max Ultra',
  'roborock.vacuum.a97': 'Roborock S8 MaxV Ultra',
  'roborock.vacuum.s4': 'Roborock S4',
  'roborock.vacuum.s5e': 'Roborock S5 Max',
  'roborock.vacuum.s6': 'Roborock S6',
  'roborock.vacuum.sc01': 'Roborock Q7 Series',
  'roborock.vacuum.sc05': 'Roborock Q7 Series',
  'roborock.vacuum.ss07': 'Roborock Q10 Series',
  'roborock.vacuum.ss09': 'Roborock Q10 Series',
};

/** The name Roborock sells model under, or model itself when it isn't in the catalogue. */
export function catalogName(model: string | null | undefined): string | null {
  return model ? NAMES[model] ?? model : null;
}

/**
 * The name to show for a robot's model: the one the server gives its product, so a new model gets a
 * proper name without an update, else the catalogue's, else the model as reported.
 */
export function productDisplayName(product: { name?: string | null; model?: string | null } | null | undefined): string | null {
  const name = product?.name?.trim();
  return name ? name : catalogName(product?.model);
}

/** The model name to show under the robot's name, or null when the robot is simply named after its model. */
export function modelSubtitle(deviceName: string, modelName: string | null | undefined): string | null {
  if (!modelName || !modelName.trim()) return null;
  return modelName.trim().toLowerCase() === deviceName.trim().toLowerCase() ? null : modelName;
}
