// The service providers' vocabulary, held to the shape every vocabulary module
// keeps (src/__tests__/vocabulary.ts): non-empty lists of kebab-case tokens,
// no value twice, and every list named in `SERVICE_PROVIDER_VOCABULARIES`.
import { defineVocabularyTests } from "../../__tests__/vocabulary"
import * as vocabulary from "../vocabulary"

defineVocabularyTests("Service providers", vocabulary, vocabulary.SERVICE_PROVIDER_VOCABULARIES, 2)
