import { connect } from 'vectordb';
import { OpenAIEmbeddings } from 'langchain/embeddings/openai';
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';

export class DocumentProcessor {
    constructor(openAiApiKey) {
        this.embeddings = new OpenAIEmbeddings({ openAIApiKey: openAiApiKey });
        this.db = null;
        this.table = null;
    }

    async initialize() {
        // Connect to LanceDB and create/get the table
        this.db = await connect('./lancedb');
        this.table = await this.db.createTable('faq', [
            { vector: [], text: '', metadata: {} }
        ]);
    }

    async processDocument(text, metadata = {}) {
        const splitter = new RecursiveCharacterTextSplitter({
            chunkSize: 1000,
            chunkOverlap: 200
        });

        const docs = await splitter.createDocuments([text], [metadata]);
        const vectors = await Promise.all(
            docs.map(async (doc) => {
                const embedding = await this.embeddings.embedQuery(doc.pageContent);
                return {
                    vector: embedding,
                    text: doc.pageContent,
                    metadata: {
                        ...doc.metadata
                    }
                };
            })
        );

        await this.table.add(vectors);
    }

    async query(question, topK = 3) {
        const queryEmbedding = await this.embeddings.embedQuery(question);
        const results = await this.table.search(queryEmbedding).limit(topK).execute();

        return results.map(match => ({
            text: match.text,
            score: match.score
        }));
    }
} 