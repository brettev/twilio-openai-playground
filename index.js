import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
//import { DocumentProcessor } from './utils/documentProcessor.js';
import twilio from 'twilio';

const args = process.argv.slice(2); // Get command line arguments
const envFile = args[0] || '.env';  // Use the provided argument or default to '.env'

// Load environment variables from .env file
dotenv.config({ path: envFile });

// Retrieve the OpenAI API key from environment variables.
const { OPENAI_API_KEY, SYSTEM_MESSAGE, VOICE, OPENING_MESSAGE, INBOUND_CALL, TRANSFER_PHONE_NUMBER } = process.env;

if (!OPENAI_API_KEY) {
    console.error('Missing OpenAI API key. Please set it in the .env file.');
    process.exit(1);
}

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const PORT = process.env.PORT || 5050; // Allow dynamic port assignment
let currentCallSid = null; // Add this line to declare the variable globally

// List of Event Types to log to the console. See the OpenAI Realtime API Documentation: https://platform.openai.com/docs/api-reference/realtime
const LOG_EVENT_TYPES = [
    'error',
    'response.content.done',
    'rate_limits.updated',
    'response.done',
    'input_audio_buffer.committed',
    'input_audio_buffer.speech_stopped',
    'input_audio_buffer.speech_started',
    'session.created'
];

// Show AI response elapsed timing calculations
const SHOW_TIMING_MATH = false;

if(false){
    // Initialize the document processor
    const documentProcessor = new DocumentProcessor(OPENAI_API_KEY);
    await documentProcessor.initialize();
}

// Root Route
fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Twilio Media Stream Server is running!' });
});

// Route for Twilio to handle incoming calls
// <Say> punctuation to improve text-to-speech translation
fastify.all('/incoming-call', async (request, reply) => {
    currentCallSid = request.body.CallSid; // Capture the CallSid from the incoming request
    console.log('Incoming call SID:', currentCallSid);
    
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Connect>
                                  <Stream url="wss://${request.headers.host}/media-stream" />
                              </Connect>
                          </Response>`;

    reply.type('text/xml').send(twimlResponse);
});

// Add this new route to handle transfers
fastify.post('/transfer', async (request, reply) => {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const client = twilio(accountSid, authToken);

    try {
        const call = await client.calls(request.body.callSid)
            .update({
                twiml: `<?xml version="1.0" encoding="UTF-8"?>
                        <Response>
                            <Say>Transferring you to an agent now.</Say>
                            <Dial>${TRANSFER_PHONE_NUMBER}</Dial>
                        </Response>`
            });
        
        reply.send({ success: true, message: 'Call transferred successfully' });
    } catch (error) {
        console.error('Error transferring call:', error);
        reply.status(500).send({ success: false, error: error.message });
    }
});

// WebSocket route for media-stream
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('Client connected');

        // Connection-specific state
        let streamSid = null;
        let latestMediaTimestamp = 0;
        let lastAssistantItem = null;
        let markQueue = [];
        let responseStartTimestampTwilio = null;

        const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "OpenAI-Beta": "realtime=v1"
            }
        });

        // Control initial session with OpenAI
        const initializeSession = () => {
            const sessionUpdate = {
                type: 'session.update',
                session: {
                    turn_detection: {
                        "type": "server_vad",
                        "threshold": 0.5,
                        "prefix_padding_ms": 300,
                        "silence_duration_ms": 500
                    },
                    input_audio_format: 'g711_ulaw',
                    output_audio_format: 'g711_ulaw',
                    voice: VOICE,
                    instructions: SYSTEM_MESSAGE,
                    modalities: ["text", "audio"],
                    temperature: 0.8,
                    tools: [/* {
                        type: 'function',
                        name: 'transferToSpecialist',
                        description: 'completes the call and transfers the caller to a specialist. ONLY USE THIS IF THE CALLER IS INTERESTED IN LEARNING MORE ABOUT HOME SECURITY SOLUTIONS',
                        parameters: {
                          type: 'object',
                          properties: {
                            sid: {
                              type: 'string',
                              description: 'the current call SID'
                            }
                          },
                          required: ['sid']
                        }
                      },
                      {
                        type: 'function',
                        name: 'mergeCalls',
                        description: 'Merges the customer call with the specialist call',
                        parameters: {
                          type: 'object',
                          properties: {
                            sid: {
                              type: 'string',
                              description: 'the current call SID'
                            }
                          },
                          required: ['sid']
                        }
                      },
                      {
                        type: 'function',
                        name: 'findHistory',
                        description: 'Pulls up the customer\'s home loan history and current loan balance',
                        parameters: {
                          type: 'object',
                          properties: {
                            phone: {
                              type: 'string',
                              description: 'the customer\'s phone number'
                            }
                          },
                          required: ['phone']
                        }
                      }, */
                      {
                        type: 'function',
                        name: 'scheduleCallback',
                        description: 'Schedules a callback with the customer. Make sure you ask for the time and date they would like to be called back.',
                        parameters: {
                          type: 'object',
                          properties: {
                            phone: {
                              type: 'string',
                              description: 'the customer\'s phone number'
                            },
                            time: {
                              type: 'string',
                              description: 'the time the customer would like to be called back'
                            },
                            date: {
                              type: 'string',
                              description: 'the date the customer would like to be called back'
                            }
                          },
                          required: ['phone', 'time', 'date']
                        }
                      },
                      {
                        type: 'function',
                        name: 'addToDNC',
                        description: 'Adds the customer to the do not call list. Make sure you ask for their phone number before adding them.',
                        parameters: {
                          type: 'object',
                          properties: {
                            phone: {
                              type: 'string',
                              description: 'the customer\'s phone number'
                            }
                          },
                          required: ['phone']
                        }
                      },
                      /* {
                        type: 'function',
                        name: 'transferToAgent',
                        description: 'transfers the caller to an agent. typically in the event that they are getting really frustrated and need to be transferred to a human. ONLY USE THIS IF THE USER IS FRUSTRATED',
                        parameters: {
                          type: 'object',
                          properties: {
                            sid: {
                              type: 'string',
                              description: 'the current call SID'
                            }
                          },
                          required: ['sid']
                        }
                      } */
                    ],
                    tool_choice: 'auto'
                }
            };

            console.log('Sending session update:', JSON.stringify(sessionUpdate));
            openAiWs.send(JSON.stringify(sessionUpdate));

            // Uncomment the following line to have AI speak first:
            if(INBOUND_CALL) sendInitialConversationItem();
        };

        // Send initial conversation item if AI talks first
        const sendInitialConversationItem = async () => {
            // Query relevant FAQ documents for the initial greeting
            //const relevantDocs = await documentProcessor.query("security system introduction");
            
            const initialConversationItem = {
                type: 'conversation.item.create',
                item: {
                    type: 'message',
                    role: 'assistant',
                    content: [
                        {
                            type: 'input_text',
                            text: OPENING_MESSAGE
                        }
                    ],
                    //context: {
                    //    relevant_docs: relevantDocs
                    //}
                }
            };

            if (SHOW_TIMING_MATH) console.log('Sending initial conversation item:', JSON.stringify(initialConversationItem));
            openAiWs.send(JSON.stringify(initialConversationItem));
            openAiWs.send(JSON.stringify({ type: 'response.create' }));
        };

        // Handle interruption when the caller's speech starts
        const handleSpeechStartedEvent = () => {
            if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
                const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
                if (SHOW_TIMING_MATH) console.log(`Calculating elapsed time for truncation: ${latestMediaTimestamp} - ${responseStartTimestampTwilio} = ${elapsedTime}ms`);

                if (lastAssistantItem) {
                    const truncateEvent = {
                        type: 'conversation.item.truncate',
                        item_id: lastAssistantItem,
                        content_index: 0,
                        audio_end_ms: elapsedTime
                    };
                    if (SHOW_TIMING_MATH) console.log('Sending truncation event:', JSON.stringify(truncateEvent));
                    openAiWs.send(JSON.stringify(truncateEvent));
                }

                connection.send(JSON.stringify({
                    event: 'clear',
                    streamSid: streamSid
                }));

                // Reset
                markQueue = [];
                lastAssistantItem = null;
                responseStartTimestampTwilio = null;
            }
        };

        // Send mark messages to Media Streams so we know if and when AI response playback is finished
        const sendMark = (connection, streamSid) => {
            if (streamSid) {
                const markEvent = {
                    event: 'mark',
                    streamSid: streamSid,
                    mark: { name: 'responsePart' }
                };
                connection.send(JSON.stringify(markEvent));
                markQueue.push('responsePart');
            }
        };

        // Open event for OpenAI WebSocket
        openAiWs.on('open', () => {
            console.log('Connected to the OpenAI Realtime API');
            setTimeout(initializeSession, 100);
        });

        // Listen for messages from the OpenAI WebSocket (and send to Twilio if necessary)
        openAiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);

                if (LOG_EVENT_TYPES.includes(response.type)) {
                    console.log(`Received event: ${response.type}`, response);
                }

                if (response.type === 'response.audio.delta' && response.delta) {
                    const audioDelta = {
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: Buffer.from(response.delta, 'base64').toString('base64') }
                    };
                    connection.send(JSON.stringify(audioDelta));

                    // First delta from a new response starts the elapsed time counter
                    if (!responseStartTimestampTwilio) {
                        responseStartTimestampTwilio = latestMediaTimestamp;
                        if (SHOW_TIMING_MATH) console.log(`Setting start timestamp for new response: ${responseStartTimestampTwilio}ms`);
                    }

                    if (response.item_id) {
                        lastAssistantItem = response.item_id;
                    }
                    
                    sendMark(connection, streamSid);
                }

                if (response.type === 'response.output_item.done'){
                    const { item } = response;
                    
                    if (item.type === 'function_call') {
                        if (item.name === 'transferToSpecialist') {
                                                        
                            openAiWs.send(JSON.stringify({
                            type: 'conversation.item.create',
                            item: {
                                type: 'function_call_output',
                                call_id: item.call_id,
                                output: "Right here, transfer to specialist"
                            }
                            }));
                            
                            openAiWs.send(JSON.stringify({ type: 'response.create' }));
                            
                        }
                        if (item.name === 'scheduleCallback') {

                            console.log('Scheduling callback:', item);
                            //hit up five9 API with the phone number, time, and date using the F9TimeToCall and F9TimeFormat parameters
                            /**
                             * Scheduling callback: {
                                id: 'item_ASqli8tfaeRjOPf5Vvkwk',
                                object: 'realtime.item',
                                type: 'function_call',
                                status: 'completed',
                                name: 'scheduleCallback',
                                call_id: 'call_0vkZ0rgs8dYBsPgo',
                                arguments: '{"phone":"801-599-0584","time":"15:00","date":"2024-11-13"}'
                                }
                             */
                                                        
                            openAiWs.send(JSON.stringify({
                            type: 'conversation.item.create',
                            item: {
                                type: 'function_call_output',
                                call_id: item.call_id,
                                output: "Callback Scheduled"
                            }
                            }));
                            
                            openAiWs.send(JSON.stringify({ type: 'response.create' }));
                            
                        }
                        if (item.name === 'addToDNC') {

                            console.log('Adding to DNC:', item);
                            //hit up five9 API with the phone number, time, and date using the F9TimeToCall and F9TimeFormat parameters
                            /**
                             * Adding to DNC: {
                                id: 'item_ASqli8tfaeRjOPf5Vvkwk',
                                object: 'realtime.item',
                                type: 'function_call',
                                status: 'completed',
                                name: 'addToDNC',
                                call_id: 'call_0vkZ0rgs8dYBsPgo',
                                arguments: '{"phone":"801-599-0584","time":"15:00","date":"2024-11-13"}'
                                }
                             */
                                                        
                            openAiWs.send(JSON.stringify({
                            type: 'conversation.item.create',
                            item: {
                                type: 'function_call_output',
                                call_id: item.call_id,
                                output: "Added to DNC"
                            }
                            }));
                            
                            openAiWs.send(JSON.stringify({ type: 'response.create' }));
                            
                        }
                        if (item.name === 'findHistory') {
                                                        
                            openAiWs.send(JSON.stringify({
                            type: 'conversation.item.create',
                            item: {
                                type: 'function_call_output',
                                call_id: item.call_id,
                                output: "Right here, I'm pulling up your home loan history and current loan balance."
                            }
                            }));
                            
                            openAiWs.send(JSON.stringify({ type: 'response.create' }));
                            
                        }
                        if (item.name === 'mergeCalls') {
                            
                            openAiWs.send(JSON.stringify({
                            type: 'conversation.item.create',
                            item: {
                                type: 'function_call_output',
                                call_id: item.call_id,
                                output: "Right here, merge the calls"
                            }
                            }));
                            
                            openAiWs.send(JSON.stringify({ type: 'response.create' }));
                            
                        }
                        if (item.name === 'transferToAgent') {
                            // Make an internal call to the transfer endpoint
                            fetch(`https://${request.headers.host}/transfer`, {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                },
                                body: JSON.stringify({ callSid: currentCallSid })
                            }).catch(error => console.error('Error initiating transfer:', error));
                            
                            openAiWs.send(JSON.stringify({
                                type: 'conversation.item.create',
                                item: {
                                    type: 'function_call_output',
                                    call_id: item.call_id,
                                    output: "I understand you'd like to speak with a human agent. I'm transferring you now."
                                }
                            }));
                            
                            openAiWs.send(JSON.stringify({ type: 'response.create' }));
                        }
                    }
                }

                if (response.type === 'input_audio_buffer.speech_started') {
                    handleSpeechStartedEvent();
                }
            } catch (error) {
                console.error('Error processing OpenAI message:', error, 'Raw message:', data);
            }
        });

        // Handle incoming messages from Twilio
        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message);

                switch (data.event) {
                    case 'media':
                        latestMediaTimestamp = data.media.timestamp;
                        if (SHOW_TIMING_MATH) console.log(`Received media message with timestamp: ${latestMediaTimestamp}ms`);
                        if (openAiWs.readyState === WebSocket.OPEN) {
                            const audioAppend = {
                                type: 'input_audio_buffer.append',
                                audio: data.media.payload
                            };
                            openAiWs.send(JSON.stringify(audioAppend));
                        }
                        break;
                    case 'start':
                        streamSid = data.start.streamSid;
                        console.log('Incoming stream has started', streamSid);

                        // Reset start and media timestamp on a new stream
                        responseStartTimestampTwilio = null; 
                        latestMediaTimestamp = 0;
                        break;
                    case 'mark':
                        if (markQueue.length > 0) {
                            markQueue.shift();
                        }
                        break;
                    default:
                        console.log('Received non-media event:', data.event);
                        break;
                }
            } catch (error) {
                console.error('Error parsing message:', error, 'Message:', message);
            }
        });

        // Handle connection close
        connection.on('close', () => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            console.log('Client disconnected.');
        });

        // Handle WebSocket close and errors
        openAiWs.on('close', () => {
            console.log('Disconnected from the OpenAI Realtime API');
        });

        openAiWs.on('error', (error) => {
            console.error('Error in the OpenAI WebSocket:', error);
        });
    });
});

fastify.listen({ port: PORT }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Server is listening on port ${PORT}`);
});