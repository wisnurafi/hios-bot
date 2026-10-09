// tempvoice.js — button dispatcher for the TempVoice interface panel.
//
// Buttons use customIds like `tempvoice:name`; interactionCreate splits on ':'
// and routes to this handler with args = ['name'].

import { dispatchTempVoiceButton } from '../../../services/tempvoiceInterface.js';

export default {
    name: 'tempvoice',
    async execute(interaction, client, args) {
        const action = args?.[0];
        await dispatchTempVoiceButton(interaction, client, action);
    },
};
