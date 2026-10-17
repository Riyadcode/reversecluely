document.addEventListener('DOMContentLoaded', () => {    
    const logger = {
        info: (...args) => console.log('[SettingsWindowUI]', ...args)
    };

    // Get DOM elements
    const closeButton = document.getElementById('closeButton');
    const quitButton = document.getElementById('quitButton');
    const speechProviderSelect = document.getElementById('speechProvider');
    const azureKeyInput = document.getElementById('azureKey');
    const azureRegionInput = document.getElementById('azureRegion');
    const whisperCommandInput = document.getElementById('whisperCommand');
    const whisperModelInput = document.getElementById('whisperModel');
    const whisperLanguageInput = document.getElementById('whisperLanguage');
    const whisperDeviceSelect = document.getElementById('whisperDevice');
    const whisperCaptureModeSelect = document.getElementById('whisperCaptureMode');
    const whisperResponseTargetSelect = document.getElementById('whisperResponseTarget');
    const whisperSegmentMsInput = document.getElementById('whisperSegmentMs');
    const geminiKeyInput = document.getElementById('geminiKey');
    const windowGapInput = document.getElementById('windowGap');
    const codingLanguageSelect = document.getElementById('codingLanguage');
    const activeSkillSelect = document.getElementById('activeSkill');
    const iconGrid = document.getElementById('iconGrid');
    const audioSourceSelect = document.getElementById('audioSource');
    const spokenLanguagesInput = document.getElementById('spokenLanguages');
    const answerLanguageSelect = document.getElementById('answerLanguage');
    const questionModeSelect = document.getElementById('questionMode');

    // Check if window.api exists
    if (!window.api) {
        console.error('window.api not available');
        return;
    }

    // Request current settings when window opens
    const requestCurrentSettings = () => {
        if (window.electronAPI && window.electronAPI.getSettings) {
            window.electronAPI.getSettings().then(settings => {
                loadSettingsIntoUI(settings);
            }).catch(error => {
                console.error('Failed to get settings:', error);
            });
        }
    };

    // Close button handler
    if (closeButton) {
        closeButton.addEventListener('click', () => {
            window.api.send('close-settings');
        });
    }

    // Quit button handler with multiple attempts
    if (quitButton) {
        quitButton.addEventListener('click', () => {
            try {
                // Try multiple ways to quit the app
                if (window.api && window.api.send) {
                    window.api.send('quit-app');
                }
                
                // Also try the electron API if available
                if (window.electronAPI && window.electronAPI.quit) {
                    window.electronAPI.quit();
                }
                
                // Fallback: close the window
                setTimeout(() => {
                    window.close();
                }, 500);
                
            } catch (error) {
                console.error('Error quitting app:', error);
                window.close();
            }
        });
    }

    // Function to load settings into UI
    const loadSettingsIntoUI = (settings) => {
        if (settings.speechProvider && speechProviderSelect) speechProviderSelect.value = settings.speechProvider;
        // Always set the input value, even if empty, so the user sees what's
        // currently configured (including env-derived defaults). Previously
        // empty strings were skipped which left stale UI values.
        if (azureKeyInput) azureKeyInput.value = settings.azureKey || '';
        if (azureRegionInput) azureRegionInput.value = settings.azureRegion || '';
        if (whisperCommandInput) whisperCommandInput.value = settings.whisperCommand || '';
        if (whisperModelInput) whisperModelInput.value = settings.whisperModel || '';
        if (whisperLanguageInput) whisperLanguageInput.value = settings.whisperLanguage || '';
        if (whisperDeviceSelect) whisperDeviceSelect.value = settings.whisperDevice || 'auto';
        if (whisperCaptureModeSelect) whisperCaptureModeSelect.value = settings.whisperCaptureMode || 'vad';
        if (whisperResponseTargetSelect) whisperResponseTargetSelect.value = settings.whisperResponseTarget || 'both';
        if (whisperSegmentMsInput) whisperSegmentMsInput.value = settings.whisperSegmentMs || '';
        if (geminiKeyInput) geminiKeyInput.value = settings.geminiKey || '';
        if (windowGapInput) windowGapInput.value = settings.windowGap || '';
        if (audioSourceSelect) audioSourceSelect.value = settings.audioSource || 'both';
        if (spokenLanguagesInput) spokenLanguagesInput.value = settings.spokenLanguages || 'en,fr,ar';
        if (answerLanguageSelect) answerLanguageSelect.value = settings.answerLanguage || 'match';
        if (questionModeSelect) questionModeSelect.value = settings.questionMode || 'questions';

        // Set C++ as default if no coding language is specified
        if (codingLanguageSelect) {
            codingLanguageSelect.value = settings.codingLanguage || 'cpp';
        }

        if (settings.activeSkill && activeSkillSelect) activeSkillSelect.value = settings.activeSkill;

        // Handle icon selection
        const selectedIcon = settings.selectedIcon || settings.appIcon;
        if (selectedIcon && iconGrid) {
            const iconOptions = iconGrid.querySelectorAll('.icon-option');
            iconOptions.forEach(option => {
                if (option.dataset.icon === selectedIcon) {
                    option.classList.add('selected');
                } else {
                    option.classList.remove('selected');
                }
            });
        }

        updateSpeechFieldStates();
    };

    // Load settings when window opens
    window.api.receive('load-settings', (settings) => {
        loadSettingsIntoUI(settings);
    });

    // Listen for settings window shown event
    if (window.electronAPI && window.electronAPI.receive) {
        window.electronAPI.receive('settings-window-shown', () => {
            requestCurrentSettings();
        });

    // Listen for coding language changes from other windows via helper
    window.electronAPI.onCodingLanguageChanged((event, data) => {
            if (data && data.language && codingLanguageSelect) {
                codingLanguageSelect.value = data.language;
                console.log('Language updated from overlay window:', data.language);
            }
    });
    }

    // Save settings helper function
    const saveSettings = () => {
        const settings = {};
        if (speechProviderSelect) settings.speechProvider = speechProviderSelect.value;
        if (azureKeyInput) settings.azureKey = azureKeyInput.value;
        if (azureRegionInput) settings.azureRegion = azureRegionInput.value;
        if (whisperCommandInput) settings.whisperCommand = whisperCommandInput.value;
        if (whisperModelInput) settings.whisperModel = whisperModelInput.value;
        if (whisperLanguageInput) settings.whisperLanguage = whisperLanguageInput.value;
        if (whisperDeviceSelect) settings.whisperDevice = whisperDeviceSelect.value;
        if (whisperCaptureModeSelect) settings.whisperCaptureMode = whisperCaptureModeSelect.value;
        if (whisperResponseTargetSelect) settings.whisperResponseTarget = whisperResponseTargetSelect.value;
        if (whisperSegmentMsInput) settings.whisperSegmentMs = whisperSegmentMsInput.value;
        if (geminiKeyInput) settings.geminiKey = geminiKeyInput.value;
        if (windowGapInput) settings.windowGap = windowGapInput.value;
        if (codingLanguageSelect) settings.codingLanguage = codingLanguageSelect.value;
        if (activeSkillSelect) settings.activeSkill = activeSkillSelect.value;
        if (audioSourceSelect) settings.audioSource = audioSourceSelect.value;
        if (spokenLanguagesInput) settings.spokenLanguages = spokenLanguagesInput.value;
        if (answerLanguageSelect) settings.answerLanguage = answerLanguageSelect.value;
        if (questionModeSelect) settings.questionMode = questionModeSelect.value;
        
        window.api.send('save-settings', settings);
    };

    const updateSpeechFieldStates = () => {
        const provider = speechProviderSelect ? speechProviderSelect.value : 'azure';

        // Show/hide provider-specific field groups instead of just disabling
        // them. This keeps the settings UI clean — only the relevant fields
        // for the selected provider are visible.
        const azureGroup = document.getElementById('azureFields');
        const whisperGroup = document.getElementById('whisperFields');
        const azureNote = document.getElementById('azureFieldsNote');

        if (azureGroup) {
            azureGroup.style.display = provider === 'azure' ? '' : 'none';
        }
        if (whisperGroup) {
            whisperGroup.style.display = provider === 'whisper' ? '' : 'none';
        }
        if (azureNote) {
            azureNote.style.display = provider === 'azure' ? '' : 'none';
        }

        // Also toggle disabled attribute for any leftover direct field refs
        [azureKeyInput, azureRegionInput].forEach(input => {
            if (input) input.disabled = provider !== 'azure';
        });
        [whisperCommandInput, whisperModelInput, whisperLanguageInput, whisperDeviceSelect,
            whisperCaptureModeSelect, whisperResponseTargetSelect, whisperSegmentMsInput].forEach(input => {
            if (input) input.disabled = provider !== 'whisper';
        });
    };

    // Add event listeners for all inputs
    const inputs = [
        azureKeyInput,
        azureRegionInput,
        whisperCommandInput,
        whisperModelInput,
        whisperLanguageInput,
        whisperDeviceSelect,
        whisperCaptureModeSelect,
        whisperResponseTargetSelect,
        whisperSegmentMsInput,
        geminiKeyInput,
        windowGapInput,
        audioSourceSelect,
        spokenLanguagesInput,
        answerLanguageSelect,
        questionModeSelect
    ];

    inputs.forEach(input => {
        if (input) {
            input.addEventListener('change', saveSettings);
            input.addEventListener('blur', saveSettings);
        }
    });

    if (speechProviderSelect) {
        speechProviderSelect.addEventListener('change', () => {
            updateSpeechFieldStates();
            saveSettings();
        });
    }

    // Language selection handler
    if (codingLanguageSelect) {
        codingLanguageSelect.addEventListener('change', (e) => {
            const lang = e.target.value;
            // use electronAPI so main broadcast is consistent
            if (window.electronAPI && window.electronAPI.saveSettings) {
                window.electronAPI.saveSettings({ codingLanguage: lang });
            } else {
                // fallback
                saveSettings();
            }
        });
    }

    // Skill selection handler
    if (activeSkillSelect) {
        activeSkillSelect.addEventListener('change', (e) => {
            saveSettings();
            // Also update the main window
            window.api.send('update-skill', e.target.value);
        });
    }

    updateSpeechFieldStates();

    // ── Interview prep documents ──
    const docList = document.getElementById('docList');
    const docErrors = document.getElementById('docErrors');
    const notesEditor = document.getElementById('notesEditor');
    const notesTitle = document.getElementById('notesTitle');
    const notesText = document.getElementById('notesText');
    const writeNotesButton = document.getElementById('writeNotesButton');
    const docKinds = [
        ['resume', 'Resume / CV'],
        ['job', 'Job description'],
        ['notes', 'Prep notes'],
        ['other', 'Reference']
    ];

    const showDocErrors = (errors) => {
        if (docErrors) docErrors.textContent = (errors || []).join('\n');
    };

    const renderDocs = (docs) => {
        if (!docList) return;
        docList.textContent = '';
        if (!docs || docs.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'doc-empty';
            empty.textContent = 'No documents yet. Answers will be generic until you add your resume.';
            docList.appendChild(empty);
            return;
        }
        docs.forEach((doc) => {
            const row = document.createElement('div');
            row.className = 'doc-row' + (doc.enabled ? '' : ' disabled');

            const toggle = document.createElement('input');
            toggle.type = 'checkbox';
            toggle.className = 'doc-toggle';
            toggle.checked = doc.enabled;
            toggle.setAttribute('aria-label', `Use ${doc.name} in answers`);
            toggle.addEventListener('change', () => {
                window.electronAPI.updateContextDoc(doc.id, { enabled: toggle.checked }).then(handleDocResult);
            });

            const main = document.createElement('div');
            main.className = 'doc-main';
            const name = document.createElement('div');
            name.className = 'doc-name';
            name.dir = 'auto';
            name.textContent = doc.name;
            name.title = doc.preview || doc.name;
            const meta = document.createElement('div');
            meta.className = 'doc-meta';
            const size = doc.chars >= 1000 ? `${Math.round(doc.chars / 1000)}k chars` : `${doc.chars} chars`;
            meta.textContent = doc.truncated ? `${size} · trimmed to fit` : size;
            main.append(name, meta);

            const kind = document.createElement('select');
            kind.className = 'input-field';
            kind.setAttribute('aria-label', `Type of ${doc.name}`);
            docKinds.forEach(([value, label]) => {
                const option = document.createElement('option');
                option.value = value;
                option.textContent = label;
                kind.appendChild(option);
            });
            kind.value = doc.kind;
            kind.addEventListener('change', () => {
                window.electronAPI.updateContextDoc(doc.id, { kind: kind.value }).then(handleDocResult);
            });

            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'btn btn-danger';
            remove.setAttribute('aria-label', `Remove ${doc.name}`);
            remove.innerHTML = '<i class="fas fa-trash"></i>';
            remove.addEventListener('click', () => {
                window.electronAPI.removeContextDoc(doc.id).then(handleDocResult);
            });

            row.append(toggle, main, kind, remove);
            docList.appendChild(row);
        });
    };

    const handleDocResult = (result) => {
        if (!result) return;
        renderDocs(result.docs);
        showDocErrors(result.errors);
    };

    const setNotesOpen = (open) => {
        if (!notesEditor) return;
        notesEditor.classList.toggle('open', open);
        if (writeNotesButton) writeNotesButton.setAttribute('aria-expanded', String(open));
        if (open && notesText) notesText.focus();
    };

    if (window.electronAPI && window.electronAPI.listContextDocs) {
        window.electronAPI.listContextDocs().then(renderDocs).catch((error) => {
            showDocErrors([`Could not load documents: ${error.message}`]);
        });
        window.electronAPI.onContextDocsChanged((_event, data) => {
            if (data && data.docs) renderDocs(data.docs);
        });

        const addResume = document.getElementById('addResumeButton');
        if (addResume) {
            addResume.addEventListener('click', () => {
                window.electronAPI.addContextDocFiles('resume').then(handleDocResult);
            });
        }
        const addDocs = document.getElementById('addDocsButton');
        if (addDocs) {
            addDocs.addEventListener('click', () => {
                // No kind: the main process guesses it from the file name.
                window.electronAPI.addContextDocFiles(null).then(handleDocResult);
            });
        }
        if (writeNotesButton) {
            writeNotesButton.addEventListener('click', () => {
                setNotesOpen(!notesEditor.classList.contains('open'));
            });
        }
        const cancelNotes = document.getElementById('cancelNotesButton');
        if (cancelNotes) {
            cancelNotes.addEventListener('click', () => setNotesOpen(false));
        }
        const saveNotes = document.getElementById('saveNotesButton');
        if (saveNotes) {
            saveNotes.addEventListener('click', () => {
                window.electronAPI.addContextDocText({
                    name: notesTitle ? notesTitle.value : '',
                    text: notesText ? notesText.value : '',
                    kind: 'notes'
                }).then((result) => {
                    handleDocResult(result);
                    if (result && (!result.errors || result.errors.length === 0)) {
                        if (notesTitle) notesTitle.value = '';
                        if (notesText) notesText.value = '';
                        setNotesOpen(false);
                    }
                });
            });
        }
    }

    // Initialize icon grid with correct paths
    const initializeIconGrid = () => {
        if (!iconGrid) return;

        const icons = [
            { key: 'terminal', name: 'Terminal', src: './assests/icons/terminal.png' },
            { key: 'activity', name: 'Activity', src: './assests/icons/activity.png' },
            { key: 'settings', name: 'Settings', src: './assests/icons/settings.png' }
        ];

        iconGrid.innerHTML = '';

        icons.forEach(icon => {
            const iconElement = document.createElement('div');
            iconElement.className = 'icon-option';
            iconElement.dataset.icon = icon.key;
            
            const img = document.createElement('img');
            img.src = icon.src;
            img.alt = icon.name;
            img.onload = () => {
                logger.info('Icon loaded successfully:', icon.src);
            };
            img.onerror = () => {
                console.error('Failed to load icon:', icon.src);
                // Try alternative paths
                const altPaths = [
                    `./assests/${icon.key}.png`,
                    `./assets/icons/${icon.key}.png`,
                    `./assets/${icon.key}.png`
                ];
                
                let pathIndex = 0;
                const tryNextPath = () => {
                    if (pathIndex < altPaths.length) {
                        img.src = altPaths[pathIndex];
                        pathIndex++;
                    } else {
                        img.style.display = 'none';
                        console.error('All icon paths failed for:', icon.key);
                    }
                };
                
                img.onload = () => {
                    logger.info('Icon loaded with alternative path:', img.src);
                };
                
                img.onerror = tryNextPath;
                tryNextPath();
            };
            
            const label = document.createElement('div');
            label.textContent = icon.name;
            
            iconElement.appendChild(img);
            iconElement.appendChild(label);
            
            // Click handler for icon selection
            iconElement.addEventListener('click', () => {                
                // Remove selection from all icons
                iconGrid.querySelectorAll('.icon-option').forEach(opt => {
                    opt.classList.remove('selected');
                });
                
                // Add selection to clicked icon
                iconElement.classList.add('selected');
                
                // Save the selection - this should trigger the app icon change
                window.api.send('save-settings', { selectedIcon: icon.key });
                
                // Show visual feedback
                iconElement.style.transform = 'scale(0.95)';
                setTimeout(() => {
                    iconElement.style.transform = 'scale(1)';
                }, 100);
            });
            
            iconGrid.appendChild(iconElement);
        });
    };

    // Initialize icon grid
    initializeIconGrid();

    // Request settings on load
    setTimeout(() => {
        requestCurrentSettings();
    }, 200);

    // ESC key to close
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            window.api.send('close-settings');
        }
    });
}); 
