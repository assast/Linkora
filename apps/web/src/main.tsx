import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { Toaster } from 'sonner';
import App from './App';
import { AppProvider } from './state';
import './style.css';

const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 15_000 } } });

function Notifications() {
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 720px)').matches);
  useEffect(() => {
    const viewport = window.matchMedia('(max-width: 720px)');
    const update = (event: MediaQueryListEvent) => setMobile(event.matches);
    viewport.addEventListener('change', update);
    return () => viewport.removeEventListener('change', update);
  }, []);
  return <Toaster richColors position={mobile ? 'top-center' : 'bottom-right'} offset={mobile ? 72 : 32} mobileOffset={mobile ? 72 : 16} visibleToasts={mobile ? 1 : 3} closeButton={!mobile} style={mobile ? { pointerEvents: 'none' } : undefined} />;
}

createRoot(document.getElementById('root')!).render(<QueryClientProvider client={client}><BrowserRouter><AppProvider><App /><Notifications /></AppProvider></BrowserRouter></QueryClientProvider>);
