import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from 'sonner';
import App from './App';
import { AppProvider } from './state';
import './style.css';

const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 15_000 } } });
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={client}><BrowserRouter><AppProvider><App /><Toaster richColors position="bottom-right" closeButton /></AppProvider></BrowserRouter></QueryClientProvider>);
