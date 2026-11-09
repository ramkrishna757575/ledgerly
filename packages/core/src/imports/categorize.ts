import type { Narration } from './narration.ts';

// Order matters: the first match wins, so the specific patterns come first
// ("amazon pay groceries" before plain "amazon").
const KEYWORDS: [RegExp, string][] = [
  [/amazon pay groceries|amazon fresh|bigbasket|blinkit|zepto|dmart|grofers|instamart|jiomart|milkbasket|reliance fresh|more retail|nature'?s basket|licious|country delight/i, 'Groceries'],
  [/swiggy|zomato|dominos|domino's|mcdonald|starbucks|burger king|kfc|pizza|restaurant|cafe\b|coffee|bakery|biryani|haldiram|eatsure|box8|faasos|barbeque/i, 'Food & Dining'],
  [/\buber\b|\bola\b|olacabs|rapido|namma yatri|metro rail|\bdmrc\b|\bbmtc\b|fastag|parking|blu ?smart/i, 'Transport'],
  [/indian oil|iocl|bharat petroleum|bpcl|hpcl|hindustan petroleum|shell|petrol|fuel|\bcng\b/i, 'Fuel'],
  [/netflix|spotify|hotstar|prime video|amazon prime|youtube|jiocinema|sonyliv|zee5|audible|google play|google pl\b|google one|icloud|apple\.com|chatgpt|openai|anthropic|github|notion|canva|adobe|microsoft/i, 'Subscriptions'],
  [/airtel|jio\b|jio prepaid|vodafone|\bvi\b recharge|bsnl|act fibernet|hathway|broadband|recharge/i, 'Mobile & Internet'],
  [/electricity|bescom|tneb|msedcl|bses|adani electricity|torrent power|tata power|water bill|jal board|piped gas|indane|hp gas|bharat gas|\bmgl\b|\bigl\b|gas cylinder/i, 'Utilities'],
  [/irctc|makemytrip|goibibo|indigo|air india|vistara|akasa|ixigo|redbus|cleartrip|yatra|oyo|airbnb|booking\.com/i, 'Travel'],
  [/apollo|pharmeasy|\b1mg\b|tata 1mg|medplus|netmeds|practo|hospital|clinic|diagnostic|pathlabs|dr lal|cult\.?fit|gym/i, 'Health'],
  [/\blic\b|insurance|hdfc life|sbi life|axis max|max life|star health|hdfc ergo|icici lombard|acko|digit/i, 'Insurance'],
  [/udemy|coursera|byju|unacademy|school fee|tuition|college|upgrad|vedantu/i, 'Education'],
  [/bookmyshow|\bpvr\b|\binox\b|steam|playstation|xbox/i, 'Entertainment'],
  [/income tax|\bcbdt\b|\btds\b|advance tax|property tax|professional tax/i, 'Taxes'],
  [/\brent\b|nobroker|nestaway/i, 'Rent'],
  [/\bemi\b|loan|bajaj finance|home credit/i, 'Loan EMI'],
  [/amazon|flipkart|myntra|ajio|nykaa|meesho|tata cliq|croma|reliance digital|decathlon|ikea|lenskart|firstcry/i, 'Shopping'],
];

// Names of the starter categories. A built-in guess is only a suggestion, and
// the review step always shows it before anything reaches the ledger.
export function builtinCategory(
  narration: Narration,
  description: string,
  direction: 'in' | 'out',
): string | undefined {
  if (narration.channel === 'interest' && direction === 'in') return 'Interest';
  if (narration.channel === 'charge' && direction === 'out') return 'Bank Charges';
  if (direction === 'in') return undefined;

  const haystack = `${narration.payee ?? ''} ${description}`;
  return KEYWORDS.find(([pattern]) => pattern.test(haystack))?.[1];
}
