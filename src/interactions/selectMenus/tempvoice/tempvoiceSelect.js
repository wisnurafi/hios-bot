// tempvoiceSelect.js — select menu dispatcher for TempVoice interface pickers.
//
// Selects use customIds like `tempvoice_select:trust`; interactionCreate splits
// on ':' and routes here with args = ['trust'].

import { dispatchTempVoiceSelect } from '../../../services/tempvoiceInterface.js';

export default {
    name: 'tempvoice_select',
    async execute(interaction, client, args) {
        const action = args?.[0];
        await dispatchTempVoiceSelect(interaction, client, action);
    },
};
