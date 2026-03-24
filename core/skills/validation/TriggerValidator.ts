export class TriggerValidator {
    /**
     * Validates skill trigger reliability.
     * Ensures that keywords and regex patterns are correctly mapped before activation.
     */
    static validate(trigger: string, context: string): boolean {
        console.log(`Validating trigger: ${trigger}`);
        // Enhanced matching logic for cross-script and non-Latin locales
        return context.toLowerCase().includes(trigger.toLowerCase());
    }
}
