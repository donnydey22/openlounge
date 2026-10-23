import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
const input = `@import "tailwindcss" source(none);\n@source "../../../src/components/calls";\n@source "../../../src/components/Avatar.tsx";\n@source "../../../src/components/AvatarPhoto.tsx";\n`;
const out = await postcss([tailwind({ base: process.cwd() })]).process(input, { from: process.cwd() + "/tests/e2e/stubs/tw.css" });
process.stdout.write(out.css);
