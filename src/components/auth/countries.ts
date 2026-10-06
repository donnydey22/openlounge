export interface Country {
  code: string;
  name: string;
  dial: string;
  flag: string;
  placeholder: string;
}

export const COUNTRIES: Country[] = [
  { code: "US", name: "United States", dial: "+1", flag: "🇺🇸", placeholder: "(555) 123-4567" },
  { code: "CA", name: "Canada", dial: "+1", flag: "🇨🇦", placeholder: "(555) 123-4567" },
  { code: "GB", name: "United Kingdom", dial: "+44", flag: "🇬🇧", placeholder: "7700 900123" },
  { code: "IN", name: "India", dial: "+91", flag: "🇮🇳", placeholder: "98765 43210" },
  { code: "NG", name: "Nigeria", dial: "+234", flag: "🇳🇬", placeholder: "802 123 4567" },
  { code: "DE", name: "Germany", dial: "+49", flag: "🇩🇪", placeholder: "1512 3456789" },
  { code: "FR", name: "France", dial: "+33", flag: "🇫🇷", placeholder: "6 12 34 56 78" },
  { code: "BR", name: "Brazil", dial: "+55", flag: "🇧🇷", placeholder: "11 91234-5678" },
  { code: "MX", name: "Mexico", dial: "+52", flag: "🇲🇽", placeholder: "55 1234 5678" },
  { code: "AU", name: "Australia", dial: "+61", flag: "🇦🇺", placeholder: "412 345 678" },
  { code: "JP", name: "Japan", dial: "+81", flag: "🇯🇵", placeholder: "90-1234-5678" },
  { code: "PH", name: "Philippines", dial: "+63", flag: "🇵🇭", placeholder: "917 123 4567" },
];

/** Light-touch display formatting (US/CA get (555) 123-4567; others are grouped). */
export function formatNational(digitsRaw: string, country: string) {
  const d = digitsRaw.replace(/\D/g, "");
  if (country === "US" || country === "CA") {
    if (d.length <= 3) return d;
    if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6, 10)}${d.length > 10 ? " " + d.slice(10) : ""}`;
  }
  return d.replace(/(\d{3,4})(?=\d)/g, "$1 ").trim();
}
