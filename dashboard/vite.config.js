import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Must match the GitHub repository name, or every asset 404s once deployed to
  // Pages. Served from https://<user>.github.io/ResQPack/.
  base: "/ResQPack/",
});
