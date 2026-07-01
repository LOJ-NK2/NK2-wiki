// Worker Cloudflare : traduction automatique via l'API Claude (Anthropic).
//
// Remplace MyMemory/DeepL comme moteur de traduction pour admin.html.
// Une seule requête Claude traduit le texte FR vers toutes les langues cibles
// à la fois (au lieu d'un appel par langue) pour limiter la consommation
// de tokens, et utilise le modèle Haiku (le moins cher de la gamme Claude)
// puisque la traduction de courtes fiches wiki ne demande pas un modèle plus
// puissant.
//
// Déploiement :
//   1. wrangler secret put ANTHROPIC_API_KEY   (colle ta clé API Anthropic)
//   2. wrangler deploy
//   3. Dans admin.html, mets TRANSLATE_PROXY_URL sur l'URL de ce worker
//      (ex: https://nk2-translate.<ton-compte>.workers.dev/translate).
//      Si ce worker existe déjà (route /geo), tu peux fusionner ce handler
//      dans ton fichier existant en le branchant sur `if (url.pathname === '/translate')`.
//
// Contrat HTTP (attendu par admin.html) :
//   POST { text: string, targets: string[] }
//   → 200 { translations: { [lang]: string }, errors?: { [lang]: string } }

const LANG_NAMES = {
  en: 'anglais',
  it: 'italien',
  pt: 'portugais',
  ar: 'arabe',
  ja: 'japonais',
};

// ─────────────────────────────────────────────────────────────────────────
// GLOSSAIRE DES TERMES DU JEU
// Édite cette liste puis redéploie (`wrangler deploy`).
//
// Un seul système : GLOSSARY, une entrée par terme du jeu (héros, prisonnier,
// ressource, événement...).
//   • `fr`            = forme telle qu'elle apparaît dans le texte source (obligatoire).
//   • en/it/pt/ar/ja  = forme imposée dans cette langue, UNIQUEMENT si elle diffère.
//   • Langue absente  → on conserve `fr` tel quel dans cette langue.
//
// Donc :
//   - entrée sans aucune variante  → conservée telle quelle dans TOUTES les langues.
//   - entrée avec variantes        → chaque langue précisée prend sa forme,
//                                     les autres gardent `fr`.
//
// La casse est ignorée pour repérer un terme dans le texte ; Claude applique
// ensuite la forme exacte indiquée ici. Seuls les termes réellement présents
// dans le texte sont envoyés à Claude (économie de tokens).
// ─────────────────────────────────────────────────────────────────────────
const GLOSSARY = [
  // Héros (base générée depuis images/heros/ — conservés tels quels par défaut ;
  // ajoute des variantes de langue là où le nom change, ex: { fr: 'Drake', ja: 'ドレイク' }).
  { fr: 'Ada' }, { fr: 'Aiksen' }, { fr: 'Alph' }, { fr: 'Cesar' },
  { fr: 'Devilian' }, { fr: 'Drake' }, { fr: 'Durga' }, { fr: 'Edwin' },
  { fr: 'Ekko' }, { fr: 'Flamme' }, { fr: 'Flora' }, { fr: 'Gerd' },
  { fr: 'Gimes' }, { fr: 'Harton' }, { fr: 'Inata' }, { fr: 'Ito' },
  { fr: 'Koschevoi' }, { fr: 'Lanchester' }, { fr: 'Lee' }, { fr: 'Lofili' },
  { fr: 'Lunarl' }, { fr: 'Marcus' }, { fr: 'Mia' }, { fr: 'Mireya' },
  { fr: 'Pasino' }, { fr: 'Phenix' }, { fr: 'Platos' }, { fr: 'Samir' },
  { fr: 'Sawyer' }, { fr: 'Sumo' }, { fr: 'Terry' }, { fr: 'Tormund' },
  { fr: 'Tyronn' }, { fr: 'Veronica' }, { fr: 'Vesaryon' }, { fr: 'Vivian' },
  { fr: 'Whisper' }, { fr: 'Xuanming' }, { fr: 'Zoltan' },

  // Divers.
  { fr: 'Last Oasis' },

  // Prisonniers / ressources / événements — À COMPLÉTER.
  // Exemples de forme :
  // { fr: "Guerre d'Alliance", en: 'Alliance War', it: "Guerra d'Alleanza", pt: 'Guerra de Aliança' },
  { fr: 'Vague de colère', en: 'Turmoil surge' },
  { fr: 'déflecteur', en: 'Shieldbearer' },
  { fr: 'Renseignements', en: 'Intelligence' },
  { fr: 'Alliance' },
];

// Échappe les caractères spéciaux regex d'un terme.
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Vrai si `term` apparaît dans `text` (insensible à la casse, mot entier si possible).
function textContainsTerm(text, term) {
  const t = term.trim();
  if (!t) return false;
  // \b ne marche pas pour les termes accentués/CJK ; on teste d'abord \b,
  // puis on retombe sur une simple inclusion insensible à la casse.
  try {
    const re = new RegExp('(^|[^\\p{L}])' + escapeRegex(t) + '($|[^\\p{L}])', 'iu');
    if (re.test(text)) return true;
  } catch {
    // moteur sans \p{L} : ignore
  }
  return text.toLowerCase().includes(t.toLowerCase());
}

// Construit la consigne de glossaire, filtrée aux SEULS termes présents dans
// le texte (pour économiser des tokens). Renvoie '' si rien ne s'applique.
function buildGlossaryInstruction(text, targets) {
  // Entrées du glossaire présentes dans le texte.
  const found = GLOSSARY.filter((e) => e.fr && textContainsTerm(text, e.fr));
  if (found.length === 0) return '';

  // Une entrée est "verbatim partout" si elle n'a aucune variante pour les
  // langues cibles demandées ; sinon elle passe dans le bloc par-langue.
  const hasVariant = (e) =>
    targets.some((t) => e[t] != null && e[t] !== '' && e[t] !== e.fr);
  const sameEverywhere = found.filter((e) => !hasVariant(e));
  const perLang = found.filter(hasVariant);

  let out =
    "RÈGLE IMPÉRATIVE — GLOSSAIRE DU JEU. Les termes ci-dessous sont des noms propres " +
    "du jeu (héros, prisonniers, ressources, événements). Applique EXACTEMENT la forme " +
    "imposée pour chaque langue. Ne les traduis pas librement.\n";

  if (sameEverywhere.length > 0) {
    out +=
      "• À conserver tels quels dans TOUTES les langues (y compris en arabe/japonais, " +
      "en alphabet latin) : " + sameEverywhere.map((e) => e.fr).join(', ') + ".\n";
  }

  if (perLang.length > 0) {
    out += "• Formes imposées par langue :\n";
    for (const t of targets) {
      const pairs = perLang.map((e) => {
        const v = e[t] != null && e[t] !== '' ? e[t] : e.fr; // absent → garder fr
        return `"${e.fr}"→"${v}"`;
      });
      out += `    ${t} : ${pairs.join(' ; ')}\n`;
    }
  }

  return out;
}

const SYSTEM_PROMPT =
  "Tu es un traducteur professionnel pour le wiki communautaire d'un clan du jeu vidéo Last Oasis (guerres de forteresses, ressources, récompenses). " +
  "Traduis fidèlement le texte français fourni vers chacune des langues cibles demandées. " +
  "Conserve le ton, la ponctuation et la terminologie du jeu quand elle existe.\n" +
  "RÈGLE IMPÉRATIVE SUR LES BALISES DE MISE EN FORME : le texte contient des balises de type BBCode " +
  "— [b]…[/b] (gras), [i]…[/i] (italique), [u]…[/u] (souligné) et [c=COULEUR]…[/c] (couleur). " +
  "Tu dois recopier ces balises EXACTEMENT à l'identique, caractère pour caractère. " +
  "En particulier, le mot-clé de couleur dans [c=or], [c=rouge], [c=vert], [c=bleu], [c=violet] " +
  "est un code technique : ne le traduis JAMAIS (garde 'or', 'rouge', 'vert', 'bleu', 'violet' tels quels, " +
  "même en anglais, arabe ou japonais). Ne traduis que le texte visible situé ENTRE les balises, " +
  "et laisse les balises ouvrantes et fermantes intactes, au même endroit. " +
  "N'ajoute, ne supprime, ne réordonne aucune balise.\n" +
  "Ne commente rien, ne rajoute aucune explication : réponds uniquement avec le JSON demandé.";

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(body, status, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(env), 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(env) });
    }
    if (request.method !== 'POST') {
      return json({ error: 'Méthode non autorisée' }, 405, env);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'JSON invalide' }, 400, env);
    }

    const text = String(body.text || '').trim();
    const targets = Array.isArray(body.targets) ? body.targets.filter(Boolean) : [];
    if (!text || targets.length === 0) {
      return json({ error: 'Champs "text" et "targets" requis' }, 400, env);
    }
    if (!env.ANTHROPIC_API_KEY) {
      return json({ error: "Clé ANTHROPIC_API_KEY non configurée sur le worker" }, 500, env);
    }

    const targetList = targets.map((t) => `${t} (${LANG_NAMES[t] || t})`).join(', ');
    const schemaProps = {};
    for (const t of targets) schemaProps[t] = { type: 'string' };

    const payload = {
      // Marge large : une fiche longue traduite vers 5 langues d'un coup
      // (l'arabe et le japonais consomment beaucoup de tokens) peut facilement
      // dépasser 1024 tokens de sortie. En dessous, le JSON serait tronqué.
      model: 'claude-haiku-4-5',
      max_tokens: 8192,
      system: SYSTEM_PROMPT + '\n' + buildGlossaryInstruction(text, targets),
      messages: [
        {
          role: 'user',
          content:
            `Texte source (français) :\n"""\n${text}\n"""\n\n` +
            `Traduis ce texte vers ces langues cibles : ${targetList}.`,
        },
      ],
      output_config: {
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: schemaProps,
            required: targets,
            additionalProperties: false,
          },
        },
      },
    };

    let apiResp;
    try {
      apiResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      return json({ error: 'Appel à l\'API Claude impossible : ' + e.message }, 502, env);
    }

    if (!apiResp.ok) {
      const errText = await apiResp.text();
      return json({ error: `Claude API HTTP ${apiResp.status} : ${errText.slice(0, 500)}` }, 502, env);
    }

    const data = await apiResp.json();

    if (data.stop_reason === 'refusal') {
      return json({ error: 'Traduction refusée par Claude' }, 502, env);
    }
    // Sortie tronquée : le JSON serait incomplet et impossible à parser.
    // On le signale clairement plutôt que de renvoyer un 502 opaque.
    if (data.stop_reason === 'max_tokens') {
      return json({ error: 'Texte trop long : sortie tronquée (max_tokens atteint)' }, 502, env);
    }

    const textBlock = (data.content || []).find((b) => b.type === 'text');
    if (!textBlock) {
      return json({ error: 'Réponse Claude vide' }, 502, env);
    }

    let translations;
    try {
      translations = JSON.parse(textBlock.text);
    } catch {
      return json({ error: 'JSON invalide renvoyé par Claude' }, 502, env);
    }

    const errors = {};
    for (const t of targets) {
      if (!translations[t]) errors[t] = 'traduction manquante';
    }

    return json({ translations, errors }, 200, env);
  },
};
