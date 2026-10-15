import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';
import { initTheme } from './theme';

// The theme is set before anything is drawn, so there is no flash of the wrong one.
initTheme();
mount(App, { target: document.getElementById('app')! });
