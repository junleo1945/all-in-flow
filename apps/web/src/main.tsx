import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { FeedbackProvider } from "./components/ui/Feedback";
import { LocaleProvider } from "./i18n";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LocaleProvider>
      <BrowserRouter>
        <FeedbackProvider>
          <App />
        </FeedbackProvider>
      </BrowserRouter>
    </LocaleProvider>
  </StrictMode>,
);
