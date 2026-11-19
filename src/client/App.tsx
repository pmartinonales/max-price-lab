import { useEffect, useState } from 'react';
import { SettingsScreen } from './screens/Settings';
import { RateCardScreen } from './screens/RateCard';
import { MaxPriceScreen } from './screens/MaxPrice';
import { TemplatesScreen } from './screens/Templates';
import { SendScreen } from './screens/Send';
import { ResultsScreen } from './screens/Results';
import { WebhookLogScreen } from './screens/WebhookLog';

const SCREENS = [
  { id: 'settings', label: 'Settings', Component: SettingsScreen },
  { id: 'rate-card', label: 'Rate card', Component: RateCardScreen },
  { id: 'max-price', label: 'Max price', Component: MaxPriceScreen },
  { id: 'templates', label: 'Templates', Component: TemplatesScreen },
  { id: 'send', label: 'Send', Component: SendScreen },
  { id: 'results', label: 'Results', Component: ResultsScreen },
  { id: 'webhook-log', label: 'Webhook log', Component: WebhookLogScreen },
] as const;

const current = () => {
  const id = window.location.hash.replace(/^#\/?/, '');
  return SCREENS.find((s) => s.id === id) ?? SCREENS[0];
};

export function App() {
  const [screen, setScreen] = useState(current);
  useEffect(() => {
    const onHash = () => setScreen(current());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const { Component } = screen;
  return (
    <div className="shell">
      <header className="top">
        <div className="brand">
          Max Price Lab <span>· WhatsApp marketing</span>
        </div>
        <nav>
          {SCREENS.map((s) => (
            <a key={s.id} href={`#/${s.id}`} className={s.id === screen.id ? 'active' : ''}>
              {s.label}
            </a>
          ))}
        </nav>
      </header>
      <main>
        <Component />
      </main>
    </div>
  );
}
